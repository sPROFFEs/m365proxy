import { getApiKey } from './util.mjs';

// Native local diagnostic client: no browser launch, no curl/jq dependencies,
// no automatic retries. probe sends exactly one small text request without tools.
export async function diagnose(command, config, { output = console.log } = {}) {
  const key = await getApiKey(config.stateDir);
  const base = `http://${config.host}:${config.port}`;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(config.projectId ? { 'X-M365-Project': config.projectId } : {}) };
  try {
    const health = await fetch(base + '/health', { headers, signal: AbortSignal.timeout(5000) });
    const state = await health.json();
    if (command === 'status' || !health.ok || state.auth?.state !== 'ready' || state.busy) {
      output(JSON.stringify({ endpoint: base, http_status: health.status, ...state }, null, 2));
      return health.ok && state.auth?.state === 'ready' && !state.busy ? 0 : 2;
    }
    const started = Date.now();
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers, signal: AbortSignal.timeout((Number.isInteger(state.timeouts_ms?.total) && state.timeouts_ms.total >= 1000 && state.timeouts_ms.total <= 900000 ? state.timeouts_ms.total : config.requestTimeoutMs) + 5000),
      body: JSON.stringify({ model: config.defaultModel, messages: [{ role: 'user', content: 'Reply only with the word OK.' }], stream: false }),
    });
    const body = await response.json();
    output(JSON.stringify({ endpoint: base, http_status: response.status,
      request_id: response.headers.get('x-request-id'), elapsed_ms: Date.now() - started,
      ...(response.ok ? { answer: body.choices?.[0]?.message?.content, tool_calls: body.choices?.[0]?.message?.tool_calls ?? [] } : body),
    }, null, 2));
    return response.ok ? 0 : 2;
  } catch {
    output(JSON.stringify({ endpoint: base, error: 'Cannot complete the local diagnostic request. Check the listener, port and proxy logs. No automatic retry was made.' }, null, 2));
    return 2;
  }
}
