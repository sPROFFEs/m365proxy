import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyEngine } from '../src/engine.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { normalizeRequest } from '../src/contracts.mjs';
import { delay } from '../src/util.mjs';
import { basic, toolRequest, fakeCore, fakeAuth, config, streamOf, envelope } from './helpers.mjs';
function setup(responder, overrides = {}) {
  const calls = []; let instances = 0;
  const factory = () => { const instance = ++instances; return { reset() {}, async run(prompt, model, signal, useAgent) { calls.push({ prompt, model, signal, useAgent, instance }); return responder(prompt, calls.length, signal); } }; };
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: { ...config, ...overrides }, factory });
  return { engine, calls, count: () => instances };
}
test('plain output streams text without fabricating usage', async () => {
  const { engine, calls } = setup(() => streamOf('hello'));
  const deltas = []; const result = await engine.run(engine.validate(basic()), { onDelta: (s) => deltas.push(s) });
  assert.deepEqual(deltas, ['hello']); assert.equal(result.choices[0].message.content, 'hello');
  assert.equal(result.usage, undefined); assert.equal(calls[0].useAgent, false);
});
test('tool output is buffered and converted to tool_calls', async () => {
  const { engine } = setup((prompt) => streamOf(envelope(prompt)));
  const deltas = []; const result = await engine.run(engine.validate(toolRequest()), { onDelta: (s) => deltas.push(s) });
  assert.deepEqual(deltas, []); assert.equal(result.choices[0].finish_reason, 'tool_calls'); assert.equal(result.choices[0].message.tool_calls.length, 1);
});
test('tool loop reuses exact-history session and sends only the new tool result', async () => {
  const { engine, calls, count } = setup((prompt, turn) => streamOf(turn === 1 ? envelope(prompt) : 'Result received.'));
  const body = toolRequest(); const first = await engine.run(engine.validate(body));
  const assistant = first.choices[0].message;
  const followup = { ...body, tool_choice: 'none', messages: [...body.messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'local result' }] };
  const second = await engine.run(engine.validate(followup));
  assert.equal(count(), 1); assert.equal(second.x_m365.session_reused, true);
  const forwarded = JSON.parse(calls[1].prompt); assert.equal(forwarded.messages.length, 1); assert.equal(forwarded.messages[0].name, 'echo');
});
test('an edited history never reuses a stale remote context', async () => {
  const { engine, count } = setup(() => streamOf('ok'));
  const first = await engine.run(engine.validate(basic()), { sessionId: 'x' });
  await engine.run(engine.validate({ ...basic(), messages: [{ role: 'user', content: 'changed' }, first.choices[0].message, { role: 'user', content: 'next' }] }), { sessionId: 'x' });
  assert.equal(count(), 2);
});
test('schema failures drop possibly divergent remote conversation state', async () => {
  const { engine } = setup((prompt) => streamOf(envelope(prompt, { tool: 'echo', arguments: { text: 2 } })));
  await assert.rejects(engine.run(engine.validate(toolRequest())), (e) => e.code === 'tool_contract_error');
  assert.equal(engine.sessions.size, 0); assert.equal(engine.busy, false);
});
test('one explicitly enabled formatting repair can correct invalid arguments', async () => {
  const { engine, calls } = setup((prompt, turn) => streamOf(envelope(prompt, { tool: 'echo', arguments: { text: turn === 1 ? 2 : 'fixed' } })), { repairAttempts: 1 });
  const result = await engine.run(engine.validate(toolRequest()));
  assert.equal(result.x_m365.format_repairs, 1); assert.equal(calls.length, 2);
});
test('Disengaged is never retried by format repair', async () => {
  const { engine, calls } = setup(() => streamOf('', { messageType: 'Disengaged' }), { repairAttempts: 1 });
  await assert.rejects(engine.run(engine.validate(toolRequest())), (e) => e.code === 'copilot_refusal');
  assert.equal(calls.length, 1);
});
test('quota errors do not trigger token refresh or conversation rotation', async () => {
  const { engine, calls } = setup(() => streamOf('', { throttle: { current: 10, max: 10 } }));
  await assert.rejects(engine.run(engine.validate(basic())), (e) => e.status === 429); assert.equal(calls.length, 1);
});
test('raw upstream errors are sanitized', async () => {
  const { engine } = setup(() => { throw new Error('wss://example.invalid?access_token=SECRET'); });
  await assert.rejects(engine.run(engine.validate(basic())), (e) => e.code === 'upstream_error' && !e.message.includes('SECRET'));
});
test('compat mode maps client model aliases to the default upstream route', async () => {
  const { engine, calls } = setup(() => streamOf('x'));
  const request = engine.validate({ ...basic(), model: 'gpt-5.6-think-deeper' });
  assert.equal(request.requestedModel, 'gpt-5.6-think-deeper');
  assert.equal(request.upstreamModel, 'm365-copilot');
  const result = await engine.run(request);
  assert.equal(calls[0].model, 'm365-copilot');
  assert.equal(result.model, 'gpt-5.6-think-deeper');
});
test('strict mode rejects unknown model aliases', () => {
  const { engine } = setup(() => streamOf('x'), { compatMode: false });
  assert.throws(() => engine.validate({ ...basic(), model: 'invented-model' }), /Unknown model/);
});
test('single-user backpressure rejects overlapping requests when queue is disabled', async () => {
  let unblock;
  const { engine } = setup(async () => { await new Promise((r) => { unblock = r; }); return streamOf('done'); }, { queueMaxPending: 0 });
  const first = engine.run(engine.validate(basic())); await delay(1);
  await assert.rejects(engine.run(engine.validate(basic())), (e) => e.code === 'proxy_busy');
  unblock(); await first;
});
test('abort reaches the upstream and resets the session', async () => {
  const { engine } = setup(async (_, __, signal) => { await delay(5000, signal); return streamOf('must not happen'); });
  const controller = new AbortController(); const result = engine.run(engine.validate(basic()), { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(result, (e) => e.code === 'request_aborted'); assert.equal(engine.sessions.size, 0);
});
test('session cache expiry and capacity bounds are enforced', () => {
  let now = 0; const store = new SessionStore(() => ({ reset() {} }), { maxSessions: 1, sessionTtlMs: 10, clock: () => now });
  const request = normalizeRequest(basic()); const a = store.checkout(request, 'a').entry; store.commit(a, request, { role: 'assistant', content: 'ok' });
  store.checkout(request, 'b'); assert.equal(store.size, 1); assert.ok(!store.entries.has(a.id));
  now = 100; const c = store.checkout(request, 'c').entry; assert.equal(store.size, 1); assert.equal(c.explicitId, 'c');
});

test('conversation max-turn bound rotates a compatible exact-history continuation', async () => {
  const { engine, count } = setup(() => streamOf('ok'), { sessionMaxTurns: 1 });
  const body = basic();
  const first = await engine.run(engine.validate(body));
  const secondBody = { ...body, messages: [...body.messages, first.choices[0].message, { role: 'user', content: 'next' }] };
  const second = await engine.run(engine.validate(secondBody));
  assert.equal(count(), 2);
  assert.equal(second.x_m365.session_reused, false);
});

test('conversation-mode fresh rotates every request even with exact history', async () => {
  const { engine, count } = setup(() => streamOf('ok'), { conversationMode: 'fresh' });
  const body = basic();
  const first = await engine.run(engine.validate(body));
  const secondBody = { ...body, messages: [...body.messages, first.choices[0].message, { role: 'user', content: 'next' }] };
  const second = await engine.run(engine.validate(secondBody));
  assert.equal(count(), 2);
  assert.equal(second.x_m365.session_reused, false);
});
