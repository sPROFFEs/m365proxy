// Wire-level tests use a synthetic upstream. They are not a live OpenCode test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyEngine } from '../src/engine.mjs';
import { createProxyServer } from '../src/server.mjs';
import { ollamaToChatRequest } from '../src/ollama.mjs';
import { createLogger } from '../src/logging.mjs';
import { normalizeRequest } from '../src/contracts.mjs';
import { basic, ECHO, config, fakeCore, fakeAuth, streamOf, envelope } from './helpers.mjs';
const key = 'b'.repeat(64);
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
async function fixture(t, responder = () => streamOf('hello'), overrides = {}) {
  const settings = { ...config, ...overrides };
  let count = 0, output = '';
  const auth = fakeAuth();
  const engine = new ProxyEngine({ core: fakeCore(), auth, config: settings,
    factory: () => ({ reset() {}, run: async (prompt) => { count++; return responder(prompt, count); } }) });
  const server = createProxyServer({ engine, apiKey: key, config: settings, logger: createLogger({ write: (s) => { output += s; } }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { engine.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, engine, auth, count: () => count, log: () => output,
    post: (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }) };
}
const ndjson = (text) => text.trim().split('\n').filter(Boolean).map(JSON.parse);
const sse = (text) => text.split('\n\n').filter((s) => s.startsWith('data: ') && s !== 'data: [DONE]').map((s) => JSON.parse(s.slice(6)));

test('native Ollama chat defaults to NDJSON, terminates once with done:true and no SSE markers', async (t) => {
  const f = await fixture(t); const response = await f.post('/api/chat', basic()); const text = await response.text(); const events = ndjson(text);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  assert.equal(events.filter((e) => e.done).length, 1); assert.equal(events.at(-1).done, true); assert.equal(events.at(-1).done_reason, 'stop');
  assert.equal(events.map((e) => e.message.content).join(''), 'hello'); assert.doesNotMatch(text, /data:|\[DONE\]|keepalive/);
});
test('native Ollama nonstream returns a message, not OpenAI choices', async (t) => {
  const f = await fixture(t); const response = await f.post('/api/chat', { ...basic(), stream: false }); const result = await response.json();
  assert.equal(result.message.content, 'hello'); assert.equal(result.done, true); assert.equal(result.choices, undefined);
  assert.equal(result.eval_count, undefined); // Do not fabricate token counts.
});
test('Ollama tags/show/version identify synthetic remote metadata and require the key', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/tags')).status, 401);
  const tags = await (await fetch(f.base + '/api/tags', { headers })).json(); assert.equal(tags.models[0].name, 'm365-copilot');
  const show = await (await f.post('/api/show', { model: 'm365-copilot' })).json(); assert.ok(show.capabilities.includes('tools')); assert.equal(show.x_m365.tool_calls_emulated, true);
  const version = await (await fetch(f.base + '/api/version', { headers })).json(); assert.equal(version.x_m365.ollama_server, false);
  assert.equal(f.count(), 0);
});
test('Ollama error before output remains an HTTP error with a string error field', async (t) => {
  const f = await fixture(t, () => { throw new Error('secret-token'); });
  const response = await f.post('/api/chat', basic()); const body = await response.json();
  assert.equal(response.status, 502); assert.equal(typeof body.error, 'string'); assert.doesNotMatch(body.error, /secret/);
  assert.equal(response.headers.get('x-should-retry'), 'false');
});
test('Ollama error after partial text emits an NDJSON error and never a successful done:true', async (t) => {
  const f = await fixture(t, () => ({ async *[Symbol.asyncIterator]() { yield 'partial'; throw new Error('secret'); } }));
  const response = await f.post('/api/chat', basic()); const events = ndjson(await response.text());
  assert.equal(response.status, 200); assert.equal(typeof events.at(-1).error, 'string'); assert.ok(events.every((e) => !e.done));
});
test('Ollama missing browser authentication fails immediately before any stream or upstream call', async (t) => {
  const f = await fixture(t); f.auth.status = () => ({ state: 'authentication_required' });
  const response = await f.post('/api/chat', basic()); assert.equal(response.status, 428); assert.equal(f.count(), 0);
  assert.equal(typeof (await response.json()).error, 'string');
});
test('Ollama tools use argument objects and the client can return a matching result on turn two', async (t) => {
  const f = await fixture(t, (prompt, count) => streamOf(count === 1 ? envelope(prompt) : 'finished'));
  const request = { ...basic(), tools: [ECHO], stream: false };
  const first = await (await f.post('/api/chat', request)).json();
  const call = first.message.tool_calls[0]; assert.deepEqual(call.function.arguments, { text: 'hello' });
  const response = await f.post('/api/chat', { ...request, messages: [...request.messages, first.message,
    { role: 'tool', tool_call_id: call.id, tool_name: 'echo', content: 'hello' }] });
  assert.equal(response.status, 200); assert.equal((await response.json()).message.content, 'finished');
});
test('Ollama streamed tools end normally and do not duplicate the call in the final chunk', async (t) => {
  const f = await fixture(t, (prompt) => streamOf(envelope(prompt)));
  const events = ndjson(await (await f.post('/api/chat', { ...basic(), tools: [ECHO] })).text());
  assert.equal(events.flatMap((e) => e.message?.tool_calls ?? []).length, 1); assert.equal(events.at(-1).done, true);
  assert.equal(events.at(-1).message.tool_calls, undefined);
});
test('ID-less Ollama history is deterministic and named tool results are matched', () => {
  const request = { ...basic(), messages: [...basic().messages,
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'echo', arguments: { text: 'x' } } }] },
    { role: 'tool', tool_name: 'echo', content: 'x' }] };
  const a = ollamaToChatRequest(request).body; const b = ollamaToChatRequest(request).body;
  assert.deepEqual(a, b); assert.equal(a.messages[1].tool_calls[0].id, a.messages[2].tool_call_id);
  assert.doesNotThrow(() => normalizeRequest(a, config));
});
test('ambiguous ID-less tool results are rejected, not assigned to an arbitrary call', () => {
  const request = { ...basic(), messages: [...basic().messages,
    { role: 'assistant', tool_calls: [{ function: { name: 'echo', arguments: {} } }, { function: { name: 'echo', arguments: {} } }] },
    { role: 'tool', tool_name: 'echo', content: 'x' }] };
  assert.throws(() => ollamaToChatRequest(request), /Ambiguous/);
});
test('empty Ollama tool_calls arrays do not invalidate ordinary chat history', () => {
  const request = { ...basic(), messages: [...basic().messages, { role: 'assistant', content: 'Hello', tool_calls: [] }, { role: 'user', content: 'Next' }] };
  assert.doesNotThrow(() => normalizeRequest(ollamaToChatRequest(request).body, config));
});
test('Ollama sampling controls are disclosed as ignored; images and structured output are rejected', async (t) => {
  const f = await fixture(t);
  const result = await (await f.post('/api/chat', { ...basic(), stream: false, options: { temperature: 0.2 }, think: true })).json();
  assert.ok(result.x_m365.ignored_parameters.includes('ollama.options')); assert.ok(result.x_m365.ignored_parameters.includes('ollama.think'));
  assert.equal((await f.post('/api/chat', { ...basic(), format: 'json' })).status, 400);
  assert.equal((await f.post('/api/chat', { ...basic(), messages: [{ role: 'user', content: 'Image', images: ['abc'] }] })).status, 400);
});
test('OpenAI clients using an /api baseURL keep the OpenAI SSE dialect via an explicit alias', async (t) => {
  const f = await fixture(t);
  const response = await f.post('/api/chat/completions', { ...basic(), stream: true }); const text = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(sse(text).at(-1).choices[0].finish_reason, 'stop'); assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
  assert.match(f.log(), /path=\/api\/chat\/completions/); assert.match(f.log(), /route_alias/);
});
test('repeated v1 alias is explicit in permissive mode and denied in strict mode', async (t) => {
  const f = await fixture(t); assert.equal((await f.post('/v1/v1/chat/completions', basic())).status, 200);
  const strict = await fixture(t, () => streamOf('hello'), { compatMode: false });
  assert.equal((await strict.post('/v1/v1/chat/completions', basic())).status, 404);
});
test('unknown routes and wrong verbs give actionable errors with request IDs without token leaks', async (t) => {
  const f = await fixture(t);
  const response = await f.post('/v1/messages?access_token=PRIVATE_TOKEN', basic()); const error = await response.json();
  assert.equal(response.status, 404); assert.match(error.error.message, /POST \/v1\/messages/); assert.match(error.error.message, /Request ID:/);
  assert.doesNotMatch(JSON.stringify(error) + f.log(), /PRIVATE_TOKEN/);
  const bad = await f.post('/secret-credential-in-path', basic()); assert.equal(bad.status, 404);
  assert.doesNotMatch(JSON.stringify(await bad.json()) + f.log(), /secret-credential/);
  const wrong = await fetch(f.base + '/v1/chat/completions', { headers });
  assert.equal(wrong.status, 405); assert.equal(wrong.headers.get('allow'), 'POST');
});
test('native Ollama aliases remain NDJSON rather than silently becoming OpenAI', async (t) => {
  const f = await fixture(t); const response = await f.post('/v1/api/chat', basic());
  assert.equal(response.status, 200); assert.equal(ndjson(await response.text()).at(-1).done, true);
});
test('OpenAI streamed tool loop completes two turns with one terminal event per response', async (t) => {
  const f = await fixture(t, (prompt, count) => streamOf(count === 1 ? envelope(prompt) : 'all done'));
  const request = { ...basic(), tools: [ECHO], stream: true };
  const first = await (await f.post('/v1/chat/completions', request)).text();
  const events = sse(first); const call = events.flatMap((e) => e.choices[0].delta.tool_calls ?? [])[0];
  assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls'); assert.equal((first.match(/data: \[DONE\]/g) ?? []).length, 1);
  const { index, ...historyCall } = call;
  const second = await (await f.post('/v1/chat/completions', { ...request, messages: [...request.messages,
    { role: 'assistant', content: null, tool_calls: [historyCall] }, { role: 'tool', tool_call_id: call.id, content: 'hello' }] })).text();
  const secondEvents = sse(second);
  assert.equal(secondEvents.at(-1).choices[0].finish_reason, 'stop'); assert.equal((second.match(/data: \[DONE\]/g) ?? []).length, 1);
  assert.equal(secondEvents.map((e) => e.choices[0].delta.content ?? '').join(''), 'all done');
});
