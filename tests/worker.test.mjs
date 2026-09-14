import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerModelSession } from '../src/worker-session.mjs';

function fixture(t, overrides = {}) {
  let tokens = 0;
  const session = new WorkerModelSession({
    coreModuleUrl: new URL('./fixtures/worker-core.mjs', import.meta.url).href,
    getToken: () => { tokens++; return 'SYNTHETIC_CREDENTIAL'; }, ...overrides,
  });
  t.after(() => session.reset());
  return { session, tokens: () => tokens };
}
async function collect(stream) { let output = ''; for await (const text of stream) output += text; return output; }

test('real worker preserves conversation state and fetches tokens for subsequent turns', async (t) => {
  const { session, tokens } = fixture(t);
  assert.equal(await collect(await session.run('ok', 'fixture')), 'turn-1');
  const second = await session.run('ok', 'fixture');
  assert.equal(await collect(second), 'turn-2');
  assert.equal(second.fullText, 'turn-2'); assert.equal(second.throttle.current, 2);
  assert.equal(tokens(), 2);
});
for (const mode of ['never', 'spin']) test(`terminates a real worker whose run ${mode === 'spin' ? 'blocks synchronously' : 'ignores cancellation'}`, async (t) => {
  const { session } = fixture(t);
  const controller = new AbortController();
  const started = Date.now();
  const pending = session.run(mode, 'fixture', controller.signal);
  setTimeout(() => controller.abort(new DOMException('Test timeout.', 'TimeoutError')), 120);
  await assert.rejects(pending, (e) => e.name === 'TimeoutError');
  await session.termination;
  assert.ok(Date.now() - started < 2000);
  assert.equal(session.worker, null); assert.equal(session.closed, true);
});
test('real worker iterator cancellation closes a stalled stream', async (t) => {
  const { session } = fixture(t); const controller = new AbortController();
  const stream = await session.run('gap', 'fixture', controller.signal);
  assert.equal((await stream.next()).value, 'first');
  const next = stream.next(); controller.abort();
  await assert.rejects(next, (e) => e.name === 'AbortError');
  await session.termination; assert.equal(session.worker, null);
});
test('worker errors are sanitized before reaching HTTP/log code', async (t) => {
  const { session } = fixture(t);
  await assert.rejects(session.run('raw_error', 'fixture'), (e) => e.code === 'upstream_error' && !e.message.includes('DO_NOT_LEAK'));
});
test('worker rejects missing browser auth without disclosing the credential callback error', async (t) => {
  const { session } = fixture(t, { getToken: () => { throw new Error('PRIVATE_DETAIL'); } });
  await assert.rejects(session.run('ok', 'fixture'), (e) => e.status === 428 && e.code === 'authentication_required' && !e.message.includes('PRIVATE_DETAIL'));
});
test('worker enforces bounded output buffering', async (t) => {
  const { session } = fixture(t, { maxOutputChars: 100 });
  await assert.rejects(async () => collect(await session.run('large', 'fixture')), (e) => e.code === 'output_limit');
});
test('upstream stdout and stderr are isolated from the proxy console', async (t) => {
  const { session } = fixture(t);
  assert.equal(await collect(await session.run('log', 'fixture')), 'turn-1');
  assert.ok(session.worker.stdout.listenerCount('data') > 0);
  assert.ok(session.worker.stderr.listenerCount('data') > 0);
});

test('idle upstream token callbacks are answered without starting browser login', async (t) => {
  const { session, tokens } = fixture(t);
  await collect(await session.run('prime_background', 'fixture'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(tokens(), 2);
  assert.equal(await collect(await session.run('wait_background', 'fixture', AbortSignal.timeout(1000))), 'turn-2');
});
test('an idle worker exit never silently recreates a conversation under old history', async (t) => {
  const { session } = fixture(t);
  await collect(await session.run('exit_later', 'fixture'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(session.closed, true);
  await assert.rejects(session.run('ok', 'fixture'), (e) => e.code === 'session_closed');
});
