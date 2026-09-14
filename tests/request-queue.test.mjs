import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue } from '../src/request-queue.mjs';
import { ProxyEngine } from '../src/engine.mjs';
import { basic, config, fakeAuth, fakeCore, streamOf } from './helpers.mjs';
import { delay } from '../src/util.mjs';

test('bounded admission is FIFO and one release cannot release two slots', async () => {
  const queue = new RequestQueue({ maxPending: 2, waitMs: 1000 }), order = [];
  const first = await queue.acquire();
  const p2 = queue.acquire().then((release) => { order.push(2); return release; });
  const p3 = queue.acquire().then((release) => { order.push(3); return release; });
  assert.equal(queue.status().pending, 2); first(); first();
  const r2 = await p2; assert.deepEqual(order, [2]); r2(); (await p3)();
  assert.deepEqual(order, [2, 3]); assert.equal(queue.active, false);
});
test('queue full, timeout and queued cancellation have distinct errors and free slots', async () => {
  const queue = new RequestQueue({ maxPending: 1, waitMs: 30 }), first = await queue.acquire();
  const pending = queue.acquire(); const expired = assert.rejects(pending, { code: 'queue_timeout' });
  await assert.rejects(queue.acquire(), { code: 'queue_full' }); await expired;
  const ctrl = new AbortController(), second = queue.acquire({ signal: ctrl.signal });
  ctrl.abort(); await assert.rejects(second, { name: 'AbortError' });
  assert.equal(queue.status().pending, 0); first(); (await queue.acquire())();
});
test('closing queue rejects pending and future requests', async () => {
  const queue = new RequestQueue(), first = await queue.acquire(), pending = queue.acquire();
  queue.close(); await assert.rejects(pending, { code: 'proxy_stopping' }); first();
  await assert.rejects(queue.acquire(), { code: 'proxy_stopping' });
});
test('engine serializes two overlapping requests without immediate proxy_busy', async () => {
  let concurrent = 0, max = 0;
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: { ...config, queueMaxPending: 4 },
    factory: () => ({ reset() {}, async run() { concurrent++; max = Math.max(max, concurrent); await delay(30); concurrent--; return streamOf('OK'); } }) });
  try {
    const replies = await Promise.all([engine.run(engine.validate(basic())), engine.run(engine.validate(basic()))]);
    assert.equal(max, 1); assert.equal(replies.length, 2); assert.equal(engine.health().queue.pending, 0);
  } finally { engine.close(); }
});
test('expired auth is checked again when a queued request reaches the front', async () => {
  const auth = fakeAuth(); let started = 0, end;
  const engine = new ProxyEngine({ core: fakeCore(), auth, config,
    factory: () => ({ reset() {}, async run() { started++; await new Promise((r) => end = r); return streamOf('OK'); } }) });
  const first = engine.run(engine.validate(basic())); await delay(10);
  const second = engine.run(engine.validate(basic()));
  auth.status = () => ({ state: 'authentication_required' }); end();
  try { await first; await assert.rejects(second, { code: 'authentication_required' }); assert.equal(started, 1); }
  finally { engine.close(); }
});
