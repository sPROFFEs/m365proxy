// Service lifetime is separated from CLI parsing so real OS-signal regressions
// can be exercised with a fake browser, without installing or logging in to M365.
import { getApiKey, acquireLock } from './util.mjs';
import { loadCore, loadChromium } from './core-loader.mjs';
import { BrowserSessionAuth } from './auth.mjs';
import { ProxyEngine } from './engine.mjs';
import { createProxyServer } from './server.mjs';
import { createLogger, observeAuth } from './logging.mjs';
import { WorkspaceManager } from './workspace.mjs';
import { BrowserUploadTransport, NativeBrowserUI, loadUploadUI } from './browser-upload.mjs';
import { isUploadMode, COPILOT_FILES_PER_MESSAGE } from './upload-manifest.mjs';
import { abortable } from './lifecycle.mjs';

export async function runService(config, { command = 'serve', coreLoader = loadCore, chromiumLoader = loadChromium,
  authFactory = (settings, chromium) => new BrowserSessionAuth(settings, { chromium }),
  output = console, cleanupTimeoutMs = 5000 } = {}) {
  let release, auth, server, engine, unwatchAuth;
  const exit = new AbortController();
  let exitCode;
  const handlers = new Map();
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const handler = () => {
      if (exit.signal.aborted) return; // Repeated Ctrl+C must not skip cleanup.
      exitCode = code;
      output.error(`[SHUTDOWN] ${signal}: stopping requests and closing the dedicated browser.`);
      exit.abort(new DOMException('Interrupted.', 'AbortError'));
    };
    process.on(signal, handler); handlers.set(signal, handler);
  }
  try {
    release = await acquireLock(config.stateDir, { signal: exit.signal,
      onRecovery: ({ pid }) => output.error(`[LOCK] Recovered stale process.lock for PID ${pid}.`) });
    const core = await abortable(coreLoader, exit.signal);
    const chromium = await abortable(chromiumLoader, exit.signal);
    const apiKey = await abortable(() => getApiKey(config.stateDir), exit.signal);
    auth = authFactory(config, chromium);
    unwatchAuth = observeAuth(auth);
    if (command === 'serve') {
      const logger = createLogger();
      const workspace = await abortable(() => WorkspaceManager.fromConfig(config, apiKey), exit.signal);
      const usesUpload = [...workspace.projects.values()].some((p) => isUploadMode(p.mode));
      const upload = usesUpload ? new BrowserUploadTransport({ auth, config, ui: new NativeBrowserUI(await loadUploadUI(config.uploadUiFile)) }) : null;
      engine = new ProxyEngine({ core, auth, config, workspace, upload, logger });
      if (usesUpload) {
        output.log('[UPLOAD] EXPERIMENTAL: native Copilot uploader and same-tab prompt. Files go to Microsoft storage; closing a tab does not delete them.');
        output.log(`[UPLOAD] Conversation mode=${config.conversationMode}: reuse claims the initial authenticated Copilot tab and keeps it for sequential turns. Exact history is preferred; browser mode has a sticky fallback for clients that rewrite/omit history.`);
        output.log(`[UPLOAD] Copilot attachment limit: ${COPILOT_FILES_PER_MESSAGE} files per message. Larger selected sets are staged in <=${COPILOT_FILES_PER_MESSAGE}-file context-sync messages inside the SAME chat; only the final message carries the user request.`);
        output.log('[UPLOAD] No prompt fallback. Old remote attachments/chats are not deleted by the proxy. Model is selected by Copilot web, not by the API model label.');
      }
      if (workspace.projects.size) {
        output.log('[CONTEXT] Enabled. context-policy=adaptive avoids loading project source for unrelated questions; always restores the old every-turn behavior.');
        for (const project of workspace.projects.values()) output.log(`[CONTEXT] Project ${project.id}: mode=${project.mode}, policy=${project.contextPolicy}, write_mode=${project.writeMode}, exec_mode=${project.execMode}, conversation=${project.conversationMode}, max_files=${project.maxFiles}, max_bytes=${project.maxBytes}. Base: http://${config.host}:${config.port}/projects/${project.id}/v1`);
        const execProjects = [...workspace.projects.values()].filter((p) => p.execMode === 'script');
        if (execProjects.length) {
          output.log('[EXEC] EXPERIMENTAL: model-proposed scripts execute automatically as the current OS user with NO per-command confirmation and NO sandbox.');
          output.log(`[EXEC] Temporary scripts live under .m365proxy-tmp inside the workspace, are excluded from context, and are deleted after execution. max_steps=${config.execMaxSteps}, step_timeout=${config.execTimeoutMs}ms, output_limit=${config.execOutputBytes} bytes.`);
          output.log('[EXEC] Proxy credentials are removed from the child environment. The scripts can still access anything allowed to this OS user. Use only on trusted workspaces/accounts.');
        }
      }
      server = createProxyServer({ engine, apiKey, config, logger });
      await abortable(() => new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(config.port, config.host, resolve);
      }), exit.signal);
      output.log(`[HTTP] Listening: http://${config.host}:${config.port}/v1 (Microsoft authentication/inference not yet verified)`);
      output.log(`[LIMITS] First text: ${config.firstTokenTimeoutMs}ms; idle: ${config.idleTimeoutMs}ms; total: ${config.requestTimeoutMs}ms.`);
      output.log(`[MODE] Tools: ${config.toolMode}; compatibility: ${config.compatMode ? 'permissive' : 'strict'}; conversations: ${config.conversationMode}; Copilot Studio disabled. Stable auto-write and experimental script execution are separate opt-in modes.`);
      output.log(`[CHECK] m365proxy status --port ${config.port} ; m365proxy probe --port ${config.port}`);
    }
    output.log('Opening a dedicated browser profile. Sign in normally, including MFA. Send a short message in the Copilot tab if needed to open Chathub.');
    await abortable(() => auth.start(), exit.signal);
    if (command === 'login') {
      await auth.getToken({ signal: exit.signal, timeoutMs: config.loginTimeoutMs, reload: false });
      output.log('Session captured. The browser profile is retained; serve will recapture a token.');
    } else {
      auth.enableMaintenance({ isBusy: () => engine.busy });
      await new Promise((resolve) => {
        if (exit.signal.aborted) resolve();
        else exit.signal.addEventListener('abort', resolve, { once: true });
      });
    }
  } catch (error) {
    if (!exit.signal.aborted || error?.name !== 'AbortError') throw error;
  } finally {
    // Each stage is independent. A throwing/hung cleanup cannot skip the lock.
    try { engine?.close(); } catch { output.error('[SHUTDOWN] Engine cleanup reported an error.'); }
    try { if (engine) await abortable(() => engine.drain(), AbortSignal.timeout(cleanupTimeoutMs)); }
    catch { output.error('[SHUTDOWN] Active turn did not drain; a partial write journal will require guarded recovery on restart.'); }
    if (server) {
      try {
        await abortable(() => new Promise((resolve) => {
          server.close(resolve); server.closeAllConnections();
        }), AbortSignal.timeout(cleanupTimeoutMs));
      } catch { output.error('[SHUTDOWN] HTTP cleanup exceeded its deadline.'); }
    }
    try {
      if (auth) await abortable(() => auth.close(), AbortSignal.timeout(cleanupTimeoutMs));
    } catch { output.error('[SHUTDOWN] Browser cleanup did not complete. Close the dedicated browser window before restarting; its profile lock is not removed.'); }
    finally {
      try { unwatchAuth?.(); }
      finally {
        try {
          if (release) { await release(); output.error('[LOCK] Released process.lock.'); }
        } finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
      }
    }
  }
  return exitCode;
}
