// Native local client. Saving happens in the running server's allowlisted
// workspace, never in a path supplied by an HTTP request or a model response.
import { boundedFile } from './workspace-cli.mjs';
import { getApiKey } from './util.mjs';
import { invalid, ProxyError, publicError } from './errors.mjs';
export async function changeCommand(command, config, { output = console.log } = {}) {
  try {
    const key = await getApiKey(config.stateDir);
    const base = `http://${config.host}:${config.port}`;
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      ...(config.projectId ? { 'X-M365-Project': config.projectId } : {}) };
    const call = async (path, body, timeoutMs = 15000) => {
      const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
      const data = await res.json();
      if (!res.ok) throw new ProxyError(res.status, data.error?.code ?? 'local_request_error', data.error?.message ?? 'Local request failed.');
      return data;
    };
    if (command === 'changes') { output(JSON.stringify(await call('/local/changes'), null, 2)); return 0; }
    if (command === 'undo') {
      if (!config.changeId) throw invalid('undo requires --change-id ID, obtained from m365proxy changes.');
      output(JSON.stringify(await call('/local/changes/undo', { change_id: config.changeId }, 960000), null, 2)); return 0;
    }
    if (command !== 'ask') throw invalid('Unknown change command.');
    const prompt = config.promptFile ? await boundedFile(config.promptFile, 65536) : config.contextQuery;
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 65536) throw invalid('ask needs --query TEXT or a UTF-8 --prompt-file FILE (up to 64 KiB).');
    const response = await call('/v1/chat/completions', { model: config.defaultModel,
      messages: [{ role: 'user', content: prompt }], stream: false }, 1810000);
    output(response.choices?.[0]?.message?.content ?? JSON.stringify(response));
    return 0;
  } catch (error) {
    const safe = error instanceof ProxyError ? error : new ProxyError(503, 'local_client_error', 'Cannot complete the local command. Check the listener, port and input file. No automatic retry was made. For an interrupted edit, inspect m365proxy changes before repeating it.');
    output(JSON.stringify(safe.toJSON(), null, 2)); return 2;
  }
}
