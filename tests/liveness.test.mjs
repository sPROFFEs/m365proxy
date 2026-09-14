import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxyEngine } from '../src/engine.mjs';
import { BrowserSessionAuth } from '../src/auth.mjs';
import { createProxyServer } from '../src/server.mjs';
import { createLogger, observeAuth } from '../src/logging.mjs';
import { diagnose } from '../src/diagnostics.mjs';
import { getApiKey, delay } from '../src/util.mjs';
import { basic, config, fakeCore, fakeAuth, streamOf, jwtUrl, toolRequest, envelope } from './helpers.mjs';

const key = 'b'.repeat(64);
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
async function fixture(t, { auth = fakeAuth(), responder = () => streamOf('OK'), ...overrides } = {}) {
  const settings = { ...config, firstTokenTimeoutMs: 1000, idleTimeoutMs: 500, ...overrides };
  let runs = 0, resets = 0; const logs = [];
  const logger = (event, data) => logs.push({ event, ...data });
  const engine = new ProxyEngine({ core: fakeCore(), auth, config: settings, logger, factory: () => ({
    reset() { resets++; }, run(...args) { runs++; return responder(...args); },
  }) });
  const server = createProxyServer({ engine, apiKey: key, config: settings, logger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { engine.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return { base: `http://127.0.0.1:${server.address().port}`, engine, settings, server, logs, runs: () => runs, resets: () => resets };
}
async function post(base, body, route = '/v1/chat/completions') {
  return fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(2500) });
}
const never = () => new Promise(() => {});

for (const route of ['/v1/chat/completions', '/v1/responses']) for (const stream of [false, true]) {
  test(`missing browser auth returns immediate 428 JSON: ${route} stream=${stream}`, async (t) => {
    const auth = new BrowserSessionAuth({ captureTimeoutMs: 45000 });
    let waits = 0; auth.getToken = () => { waits++; return never(); };
    const { base, runs } = await fixture(t, { auth });
    const start = Date.now();
    const body = route.endsWith('/responses') ? { model: 'm365-copilot', input: 'Hello', stream } : { ...basic(), stream };
    const response = await post(base, body, route);
    const result = await response.json();
    assert.equal(response.status, 428); assert.equal(result.error.code, 'authentication_required');
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('x-should-retry'), 'false');
    assert.ok(Date.now() - start < 1000); assert.equal(waits, 0); assert.equal(runs(), 0);
  });
}
test('a captured token does not falsely claim upstream verification', async (t) => {
  const { engine } = await fixture(t);
  assert.equal(engine.health().status, 'ready'); assert.equal(engine.health().upstream_status, 'not_tested');
  assert.equal(engine.health().version, '0.9.0');
});
test('a hanging run that ignores AbortSignal times out and permits a subsequent request', async (t) => {
  let count = 0;
  const { base, engine, resets } = await fixture(t, { firstTokenTimeoutMs: 50, responder: () => ++count === 1 ? never() : streamOf('OK') });
  const response = await post(base, basic());
  assert.equal(response.status, 504); assert.equal((await response.json()).error.code, 'first_token_timeout');
  assert.equal(engine.busy, false); assert.equal(engine.sessions.size, 0); assert.equal(resets(), 1);
  assert.equal(engine.health().last_error.stage, 'connecting_upstream');
  assert.equal((await post(base, basic())).status, 200);
});
test('a pending iterator.next is bounded even when return() also hangs', async (t) => {
  let returns = 0;
  const { base, engine } = await fixture(t, { firstTokenTimeoutMs: 40,
    responder: () => ({ [Symbol.asyncIterator]() { return this; }, next: never, return() { returns++; return never(); } }),
  });
  const response = await post(base, basic());
  assert.equal(response.status, 504); assert.equal((await response.json()).error.code, 'first_token_timeout');
  assert.equal(engine.busy, false); assert.equal(returns, 1);
  assert.equal(engine.health().last_error.stage, 'waiting_first_delta');
});
test('empty fragments do not reset the first-text deadline', async (t) => {
  const { base } = await fixture(t, { firstTokenTimeoutMs: 50, responder: () => ({ async *[Symbol.asyncIterator]() { for (let i = 0; i < 20; i++) { await delay(8); yield ''; } } }) });
  const response = await post(base, basic());
  assert.equal(response.status, 504); assert.equal((await response.json()).error.code, 'first_token_timeout');
});
test('idle timeout after a text delta terminates Chat SSE with an error, not stop', async (t) => {
  const { base, engine } = await fixture(t, { idleTimeoutMs: 40, responder: () => ({ async *[Symbol.asyncIterator]() { yield 'first'; await never(); } }) });
  const response = await post(base, { ...basic(), stream: true }); const text = await response.text();
  assert.equal(response.status, 200); assert.match(text, /first/); assert.match(text, /upstream_idle_timeout/); assert.match(text, /data: \[DONE\]/);
  assert.doesNotMatch(text, /"finish_reason":"stop"/); assert.equal(engine.busy, false);
});
test('idle timeout after text terminates Responses SSE with response.failed', async (t) => {
  const { base } = await fixture(t, { idleTimeoutMs: 40, responder: () => ({ async *[Symbol.asyncIterator]() { yield 'first'; await never(); } }) });
  const response = await post(base, { model: 'm365-copilot', input: 'Hello', stream: true }, '/v1/responses');
  const text = await response.text();
  assert.equal(response.status, 200); assert.match(text, /event: response\.failed/); assert.match(text, /upstream_idle_timeout/);
  assert.doesNotMatch(text, /event: response\.completed/);
});
test('first-token failures stay HTTP JSON errors even when streaming was requested', async (t) => {
  const { base } = await fixture(t, { firstTokenTimeoutMs: 40, responder: never });
  const response = await post(base, { ...basic(), stream: true });
  assert.equal(response.status, 504); assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).error.code, 'first_token_timeout');
});
test('total deadline bounds a continuously active stream', async (t) => {
  const { base, engine } = await fixture(t, { requestTimeoutMs: 110, idleTimeoutMs: 1000, responder: () => ({ async *[Symbol.asyncIterator]() {
    for (let i = 0; i < 50; i++) { yield 'a'; await delay(8); }
  } }) });
  const response = await post(base, { ...basic(), stream: true }); const text = await response.text();
  assert.match(text, /request_timeout/); assert.doesNotMatch(text, /"finish_reason":"stop"/);
  assert.equal(engine.busy, false);
});
test('health exposes a safe active stage and request id while awaiting Microsoft', async (t) => {
  let resume;
  const { base, engine } = await fixture(t, { responder: () => new Promise((r) => { resume = r; }) });
  const pending = post(base, basic());
  while (!resume) await delay(2);
  const response = await fetch(base + '/health', { headers }); const health = await response.json();
  assert.equal(health.status, 'busy'); assert.equal(health.active_request.stage, 'connecting_upstream');
  assert.match(health.active_request.request_id, /^[a-f0-9-]+$/); assert.equal(health.upstream_status, 'waiting');
  assert.ok(!JSON.stringify(health).includes('Hello'));
  resume(streamOf('OK')); await (await pending).text();
  assert.equal(engine.health().upstream_status, 'last_request_succeeded');
});
test('Responses text is observable before the upstream finishes; IDs remain consistent', async (t) => {
  let finish;
  const gate = new Promise((r) => { finish = r; });
  const { base } = await fixture(t, { responder: () => ({ async *[Symbol.asyncIterator]() { yield 'first'; await gate; yield 'second'; } }) });
  const response = await post(base, { model: 'm365-copilot', input: 'Hello', stream: true }, '/responses');
  const reader = response.body.getReader(); let text = '';
  while (!text.includes('response.output_text.delta')) text += new TextDecoder().decode((await reader.read()).value);
  assert.doesNotMatch(text, /response\.completed/); finish();
  for (;;) { const step = await reader.read(); if (step.done) break; text += new TextDecoder().decode(step.value); }
  const events = text.split('\n').filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)));
  const deltas = events.filter((e) => e.type === 'response.output_text.delta');
  assert.equal(deltas.map((d) => d.delta).join(''), 'firstsecond');
  assert.equal(events.at(-1).response.output[0].id, deltas[0].item_id);
  assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
});
test('tool proposals do not open a stream until output is complete and validated', async (t) => {
  let finish; let opened = false;
  const gate = new Promise((r) => { finish = r; });
  const { base } = await fixture(t, { responder: (prompt) => ({ async *[Symbol.asyncIterator]() { yield envelope(prompt); await gate; } }) });
  const pending = post(base, { ...toolRequest(), stream: true }).then(async (r) => { opened = true; return r.text(); });
  await delay(35); assert.equal(opened, false); finish();
  const text = await pending; assert.match(text, /"finish_reason":"tool_calls"/); assert.doesNotMatch(text, /<<<LOCAL_TOOLS/);
});
test('client disconnection aborts a non-cooperative pending upstream call', async (t) => {
  let invoked = false;
  const { base, engine, resets } = await fixture(t, { responder: () => { invoked = true; return never(); } });
  const controller = new AbortController();
  const pending = fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(basic()), signal: controller.signal }).catch(() => {});
  while (!invoked) await delay(2);
  controller.abort(); await pending;
  for (let i = 0; i < 100 && engine.busy; i++) await delay(3);
  assert.equal(engine.busy, false); assert.equal(resets(), 1);
});
test('a browser account change cancels an in-flight request and drops its session', async (t) => {
  const auth = fakeAuth();
  const { base, engine } = await fixture(t, { auth, responder: never });
  const pending = post(base, basic());
  while (!engine.busy) await delay(2);
  auth.status = () => ({ state: 'account_changed' }); auth.emit('state');
  const response = await pending; assert.equal(response.status, 428); assert.equal((await response.json()).error.code, 'account_changed');
  assert.equal(engine.sessions.size, 0); assert.equal(engine.busy, false);
});
test('failure and progress logs omit prompts, tokens, tool arguments and raw exceptions', async (t) => {
  const { base, logs } = await fixture(t, { responder: () => { throw new Error('access_token=PRIVATE_TOKEN'); } });
  const body = { ...basic(), messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] };
  await (await post(base, body)).text();
  let output = ''; const logger = createLogger({ write: (s) => { output += s; } });
  for (const row of logs) logger(row.event, row);
  logger('failed', { code: 'valid_code', stage: 'PRIVATE_TOKEN?access_token=secret', headers: 'PRIVATE_HEADERS', prompt: 'PRIVATE_PROMPT' });
  assert.match(output, /upstream_error/); assert.doesNotMatch(output, /PRIVATE_|access_token/);
});
test('auth log differentiates a captured session from verified inference', () => {
  const auth = new BrowserSessionAuth({}); let output = '';
  const off = observeAuth(auth, { write: (s) => { output += s; } });
  auth.capture(jwtUrl()); off();
  assert.match(output, /SESSION CAPTURED/); assert.match(output, /has not been verified/);
  assert.doesNotMatch(output, /eyJ|11111111/);
});
test('captured Chathub diagnostics never disclose URLs or JWTs', () => {
  const auth = new BrowserSessionAuth({}); auth.capture('wss://substrate.office.com/m365Copilot/Chathub/?access_token=PRIVATE');
  assert.equal(auth.status().last_capture_issue, 'unusable_token');
  assert.doesNotMatch(JSON.stringify(auth.status()), /PRIVATE|access_token=/);
});
test('background maintenance does not reload initial login or loop expired-token reloads', async (t) => {
  const auth = new BrowserSessionAuth({ captureTimeoutMs: 15 }); let reloads = 0;
  auth.context = { close: async () => {} }; auth.page = { reload: async () => { reloads++; } };
  t.after(() => auth.close());
  auth.enableMaintenance({ intervalMs: 5 }); await delay(25); assert.equal(reloads, 0);
  auth.capture(jwtUrl({ exp: Math.floor(Date.now() / 1000) + 100 }));
  await delay(65); assert.equal(reloads, 1);
});
test('getTokenNow is immediate and never invokes interactive getToken', () => {
  const auth = new BrowserSessionAuth({});
  auth.getToken = () => { throw new Error('Must not wait.'); };
  assert.throws(() => auth.getTokenNow(), (e) => e.status === 428);
  auth.capture(jwtUrl()); assert.equal(typeof auth.getTokenNow(), 'string');
});
test('status and probe diagnostics use the configured port and never retry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-diag-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const ownKey = await getApiKey(dir); let calls = 0; const outputs = [];
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config,
    factory: () => ({ reset() {}, run: () => { calls++; return streamOf('OK'); } }),
  });
  const server = createProxyServer({ engine, apiKey: ownKey, config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { engine.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const settings = { ...config, port: server.address().port, stateDir: dir };
  assert.equal(await diagnose('status', settings, { output: (s) => outputs.push(s) }), 0);
  assert.equal(calls, 0);
  assert.equal(await diagnose('probe', settings, { output: (s) => outputs.push(s) }), 0);
  assert.equal(calls, 1); assert.equal(JSON.parse(outputs[1]).answer, 'OK');
  assert.ok(!outputs.join('').includes(ownKey));
});
