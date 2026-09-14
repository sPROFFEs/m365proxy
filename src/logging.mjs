import { diagnosticPath } from './routes.mjs';
// Logs are deliberately an allowlist, not a dump/redaction of arbitrary objects.
// No prompts, response text, tools, headers, tokens, URLs or account IDs are logged.
export function createLogger(output = process.stderr) {
  const events = new Set(['http_request', 'route_alias', 'http_error', 'started', 'stage', 'first_delta', 'waiting', 'completed', 'failed', 'context_ready', 'queued', 'write_replayed', 'write_saved']);
  return (event, data = {}) => {
    if (!events.has(event)) return;
    const fields = [];
    if (typeof data.request_id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(data.request_id)) fields.push(data.request_id);
    if (typeof data.change_id === 'string' && /^[a-f0-9-]{36}$/.test(data.change_id)) fields.push(`change_id=${data.change_id}`);
    for (const key of ['route', 'stage', 'code']) {
      if (typeof data[key] === 'string' && /^[a-z_]{1,64}$/.test(data[key])) fields.push(`${key}=${data[key]}`);
    }
    if (['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'].includes(data.method)) fields.push(`method=${data.method}`);
    if (typeof data.path === 'string') fields.push(`path=${diagnosticPath(data.path)}`);
    for (const key of ['elapsed_ms', 'status', 'files', 'context_bytes', 'position']) if (Number.isFinite(data[key])) fields.push(`${key}=${data[key]}`);
    output.write(`${new Date().toISOString()} [REQ] ${event} ${fields.join(' ')}\n`);
  };
}

export function observeAuth(auth, output = process.stderr) {
  let previous;
  const update = () => {
    const status = auth.status();
    const signature = JSON.stringify([status.state, status.expires_at, status.refreshing, status.last_capture_issue]);
    if (signature === previous) return;
    previous = signature;
    const labels = {
      not_started: 'Waiting for the dedicated browser.',
      opening_browser: 'Opening the dedicated browser.',
      authentication_required: 'ACTION REQUIRED: sign in/MFA and send a short message in the Copilot tab. Requests are rejected immediately until a token is captured.',
      refreshing: 'Refreshing an expiring browser session in the background; no prompt is replayed.',
      ready: 'SESSION CAPTURED: requests can start. Microsoft inference has not been verified by this auth event.',
      account_changed: 'ACTION REQUIRED: account changed. Restart the proxy; cached conversations were discarded.',
      browser_closed: 'Browser closed. Inference is unavailable; restart the proxy to reopen it.',
      browser_error: 'Browser could not start. Check display, browser installation and profile lock.',
    };
    output.write(`${new Date().toISOString()} [AUTH] ${labels[status.state] ?? 'Session state changed.'}\n`);
    if (status.refreshing && status.state === 'ready') output.write('[AUTH] Expiring token is being refreshed in the background.\n');
    if (status.last_capture_issue === 'missing_access_token') output.write('[AUTH] Chathub was observed without an access_token parameter. No credential captured.\n');
    if (status.last_capture_issue === 'unusable_token') output.write('[AUTH] Chathub was observed but its credential was expired or did not match the supported format.\n');
  };
  auth.on('state', update);
  update();
  return () => auth.off('state', update);
}
