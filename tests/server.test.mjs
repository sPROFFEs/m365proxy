import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { ProxyEngine } from '../src/engine.mjs';
import { createProxyServer } from '../src/server.mjs';
import { basic, toolRequest, fakeCore, fakeAuth, config, streamOf, envelope } from './helpers.mjs';
const key = 'a'.repeat(64);
async function fixture(t, responder = () => streamOf('hello'), overrides = {}) {
  const settings = { ...config, ...overrides };
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: settings, factory: () => ({ reset() {}, run: async (prompt) => responder(prompt) }) });
  const server = createProxyServer({ engine, apiKey: key, config: settings });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, engine };
}
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
async function post(base, body) { return fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) }); }
function events(text) { return text.split('\n\n').filter((x) => x.startsWith('data: ')).map((x) => x.slice(6)).filter((x) => x !== '[DONE]').map(JSON.parse); }
test('models and health require the real local API key', async (t) => {
  const { base } = await fixture(t);
  assert.equal((await fetch(base + '/v1/models')).status, 401);
  assert.equal((await fetch(base + '/health', { headers })).status, 200);
  const response = await fetch(base + '/v1/models', { headers }); assert.equal(response.status, 200); assert.equal((await response.json()).data[0].id, 'm365-copilot');
});
test('browser Origin and DNS-rebinding Host are rejected', async (t) => {
  const { base } = await fixture(t);
  assert.equal((await fetch(base + '/v1/models', { headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(base + '/v1/models', { headers: { ...headers, Host: 'evil.invalid' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});
test('IPv6 and standard loopback Host headers are accepted', async (t) => {
  const { base } = await fixture(t);
  const port = new URL(base).port;
  for (const hostHeader of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(base + '/v1/models', { headers: { ...headers, Host: hostHeader } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 200, `Host header ${hostHeader} should be accepted`);
  }
});
test('JSON chat response has the expected OpenAI object shape', async (t) => {
  const { base } = await fixture(t); const response = await post(base, basic()); const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.object, 'chat.completion'); assert.equal(result.choices[0].message.content, 'hello');
});
test('SSE emits role, text, stop and DONE with one consistent ID', async (t) => {
  const { base } = await fixture(t); const response = await post(base, { ...basic(), stream: true }); const text = await response.text(); const chunks = events(text);
  assert.match(response.headers.get('content-type'), /text\/event-stream/); assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks[1].choices[0].delta.content, 'hello'); assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(new Set(chunks.map((c) => c.id)).size, 1); assert.match(text, /data: \[DONE\]/);
});
test('SSE tool calls have index, arguments, tool_calls finish and no raw envelope', async (t) => {
  const { base } = await fixture(t, (prompt) => streamOf(envelope(prompt)));
  const response = await post(base, { ...toolRequest(), stream: true }); const text = await response.text(); const chunks = events(text);
  const call = chunks.find((c) => c.choices[0].delta.tool_calls)?.choices[0].delta.tool_calls[0];
  assert.equal(call.index, 0); assert.equal(call.type, 'function'); assert.equal(call.function.name, 'echo'); assert.deepEqual(JSON.parse(call.function.arguments), { text: 'hello' });
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls'); assert.ok(!text.includes('<<<LOCAL_TOOLS'));
});
test('errors before output remain JSON HTTP errors even when SSE was requested', async (t) => {
  const { base } = await fixture(t, () => { throw new Error('token=SECRET'); });
  const response = await post(base, { ...basic(), stream: true }); const result = await response.json();
  assert.equal(response.status, 502); assert.equal(result.error.code, 'upstream_error');
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('bad JSON and genuinely unsupported routes are explicit errors', async (t) => {
  const { base } = await fixture(t);
  assert.equal((await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: '{' })).status, 400);
  const compatible = await post(base, { ...basic(), reasoning_effort: 'high', temperature: 0.5 });
  assert.equal(compatible.status, 200);
  assert.ok((await compatible.json()).x_m365.ignored_parameters.includes('reasoning_effort'));
  assert.equal((await fetch(base + '/v1/embeddings', { headers })).status, 404);
});

test('unversioned OpenAI aliases are accepted', async (t) => {
  const { base } = await fixture(t);
  const models = await fetch(base + '/models', { headers });
  assert.equal(models.status, 200);
  const response = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(basic()) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'hello');
});

test('Responses API JSON adapter returns output_text and function items', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5.6-think-deeper', input: 'Hello', reasoning: { effort: 'high' } }) });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.object, 'response');
  assert.equal(result.model, 'gpt-5.6-think-deeper');
  assert.equal(result.output_text, 'hello');
  assert.ok(result.x_m365.ignored_parameters.includes('responses.reasoning'));
});

test('Responses API SSE emits standard event names and completes', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(base + '/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'm365-copilot', input: 'Hello', stream: true }) });
  const text = await response.text();
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(text, /event: response\.created/);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /event: response\.completed/);
});
test('oversized body is rejected before inference', async (t) => {
  const { base } = await fixture(t, () => { throw new Error('Must not run'); }, { maxBodyBytes: 30 });
  assert.equal((await post(base, basic())).status, 413);
});
test('Responses API converts emulated tool calls to function_call items', async (t) => {
  const { base } = await fixture(t, (prompt) => streamOf(envelope(prompt)));
  const response = await fetch(base + '/v1/responses', {
    method: 'POST', headers,
    body: JSON.stringify({
      model: 'm365-copilot',
      input: 'echo hello',
      tools: [{ type: 'function', name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }],
      tool_choice: 'required',
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.output[0].type, 'function_call');
  assert.equal(result.output[0].name, 'echo');
  assert.deepEqual(JSON.parse(result.output[0].arguments), { text: 'hello' });
});
