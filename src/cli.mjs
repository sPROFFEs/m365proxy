#!/usr/bin/env node
import { readConfig } from './config.mjs';
import { getApiKey, acquireLock } from './util.mjs';
import { loadCore, loadChromium } from './core-loader.mjs';
import { publicError } from './errors.mjs';
import { diagnose } from './diagnostics.mjs';
import { workspaceCommand } from './workspace-cli.mjs';
import { runGuidedMenu } from './guided.mjs';
import { changeCommand } from './change-cli.mjs';
import { runService } from './service.mjs';
import { profileAction } from './profile-cli.mjs';

async function main() {
  let command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help') {
    console.log(`m365-copilot-local 0.9.0

Commands: menu, guided, serve, login, key, doctor, status, probe, unlock, context, propose, patch-check, ask, changes, undo
          profile list|show|run|delete|clone
Options: --port 8787 --state-dir PATH --channel chromium|msedge|chrome
         --headless --model MODEL --tool-mode guarded|cramt
         --compat (default) | --strict
         --repair-attempts 0|1 --timeout-ms 90000
         --first-token-timeout-ms 45000 --idle-timeout-ms 30000
         --workspace PATH [--workspace-id default] --context-mode read|patch|upload|hybrid
         --context-policy adaptive|always
         --workspaces FILE --context-max-bytes 65536 --context-max-files 16
         --project ID --query TEXT --prompt-file FILE --output FILE
         --upload-max-files 5 --upload-max-file-size 1048576
         --upload-max-bytes 4194304 --upload-timeout-ms 90000
         --upload-ui-config FILE
         --write-mode off|auto --queue-size 4 --queue-timeout-ms 240000
         --exec-mode off|script --exec-max-steps 4 --exec-timeout-ms 30000
         --exec-output-bytes 65536
         --conversation-mode reuse|fresh --conversation-ttl-ms 3600000
         --conversation-max 8 --conversation-max-turns 32
         --change-id ID

Named configurations:
  m365proxy menu                         interactive profile picker/editor
  m365proxy profile list                list saved profiles
  m365proxy profile run NAME            start a saved profile
  m365proxy profile show NAME           inspect a saved profile
  m365proxy profile clone OLD NEW       duplicate without overwriting NEW
  m365proxy profile delete NAME         delete config only, not workspace/login/backups

Recommended profiles are created from m365proxy guided or m365proxy menu:
  FULL WORKSPACE: workspace + local script bridge, deterministic direct Chathub (recommended).
  WORKSPACE READ-ONLY: selected context over direct Chathub, no execution.
  CHAT ONLY: no local workspace.
  ADVANCED/LEGACY: browser upload/hybrid and auto-write controls.

Conversation reuse is the default. In FULL WORKSPACE, EXEC ALWAYS stays on direct Chathub; it never
switches to the browser uploader because a prompt mentions files/code. Browser upload is isolated to
non-EXEC advanced profiles. Copilot accepts at most 3 files per browser-upload message.

Auto writes remain opt-in per workspace. --exec-mode script is an unsandboxed local host-action bridge:
Copilot proposes temporary bash/python/PowerShell/cmd scripts, the proxy executes them as the proxy OS
user, captures stdout/stderr and continues the SAME Chathub session. The bridge has bounded steps,
timeouts and one bounded format repair; it never retries actions indefinitely.
ask: send --query TEXT or --prompt-file FILE once (no CLI tools).
changes: list local write receipts; undo --change-id ID restores guarded backups from auto-write.

context: preview source manifest locally (--workspace) or via running proxy.
propose: text-only request to a patch-mode project; --output saves a proposal bundle.
patch-check: validate --proposal FILE against current bases; never applies it.

status: query /health on the configured port without starting a browser.
probe: query health, then send one short text request (no tools, no retries).
unlock: verify/recover a stale PID lock, never kill an active process.
HTTP: /v1/chat/completions and /v1/responses; native Ollama /api/chat.
Wait for [AUTH] SESSION CAPTURED before sending requests.
No passwords or TOTP seeds are requested. Login/MFA remains interactive.
`);
    return;
  }
  if (!['menu', 'guided', 'serve', 'login', 'key', 'doctor', 'status', 'probe', 'unlock', 'context', 'propose', 'patch-check', 'ask', 'changes', 'undo', 'profile', 'profiles'].includes(command)) throw new Error('Unknown command.');
  if (command === 'profiles') command = 'profile';
  if (command === 'profile') {
    const args = process.argv[2] === 'profiles' ? ['list', ...process.argv.slice(3)] : process.argv.slice(3);
    const action = await profileAction(args);
    if (action.done) return;
    const exitCode = await runService(action.config, { command: action.command });
    if (exitCode !== undefined) process.exit(exitCode);
    return;
  }
  let config = readConfig(process.argv.slice(3));
  if (command === 'menu' || command === 'guided') {
    const action = await runGuidedMenu(config, { direct: command === 'guided' });
    if (!action) return; config = action.config; command = action.command;
  }
  if (['ask', 'changes', 'undo'].includes(command)) { process.exitCode = await changeCommand(command, config); return; }
  if (['context', 'propose', 'patch-check'].includes(command)) { process.exitCode = await workspaceCommand(command, config); return; }
  if (command === 'key') { console.log(await getApiKey(config.stateDir)); return; }
  if (command === 'unlock') {
    const release = await acquireLock(config.stateDir, { onRecovery: ({ pid }) => console.error(`[LOCK] Recovered stale process.lock for PID ${pid}.`) });
    await release(); console.log('State directory is free. No active process was killed and no Chromium lock was removed.'); return;
  }
  if (command === 'status' || command === 'probe') { process.exitCode = await diagnose(command, config); return; }
  if (command === 'doctor') {
    const report = { version: '0.9.0', node: process.version, node_supported_for_upstream: Number(process.versions.node.split('.')[0]) >= 24,
      state_dir: config.stateDir, upstream: false, playwright_package: false, microsoft_login_tested: false };
    try { await loadCore(); report.upstream = true; await loadChromium(); report.playwright_package = true; }
    catch (e) { report.note = publicError(e).message; }
    console.log(JSON.stringify(report, null, 2));
    if (!report.upstream || !report.playwright_package || !report.node_supported_for_upstream) process.exitCode = 1;
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24+ to run cramt.');
  const exitCode = await runService(config, { command });
  // On an explicit signal, do not leave Node alive on a misbehaving Playwright
  // handle AFTER the bounded shutdown and lock release have finished.
  if (exitCode !== undefined) process.exit(exitCode);
}

main().catch((error) => {
  if (error?.name === 'AbortError') return;
  console.error(error?.name === 'ProxyError' ? `${error.code}: ${error.message}` : 'Startup failed. Check Node 24+, npm run setup, display and state-directory lock. Run m365proxy doctor.');
  process.exitCode = 1;
});
