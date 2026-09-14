import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyEngine } from '../src/engine.mjs';
import { WorkerModelSession } from '../src/worker-session.mjs';
import { createProxyServer } from '../src/server.mjs';
import { fakeAuth, fakeCore, config, basic } from './helpers.mjs';
import { delay } from '../src/util.mjs';
const key = 'c'.repeat(64);
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

for (const mode of ['never', 'spin']) test(`HTTP remains responsive and times out a real isolated ${mode} transport`, async (t) => {
  const settings = { ...config, firstTokenTimeoutMs: 180, idleTimeoutMs: 1000, requestTimeoutMs: 2000 };
  const core = fakeCore(); core.formatMessages = (messages) => messages[0].content;
  const workers = [];
  const engine = new ProxyEngine({ core, auth: fakeAuth(), config: settings, factory: () => {
    const worker = new WorkerModelSession({ coreModuleUrl: new URL('./fixtures/worker-core.mjs', import.meta.url).href, getToken: () => 'SYNTHETIC' });
    workers.push(worker); return worker;
  } });
  const server = createProxyServer({ engine, apiKey: key, config: settings });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { engine.close(); await Promise.all(workers.map((w) => w.reset())); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pending = fetch(base + '/v1/chat/completions', { method: 'POST', headers, signal: AbortSignal.timeout(2500),
    body: JSON.stringify({ ...basic(), messages: [{ role: 'user', content: mode }] }),
  });
  while (!engine.busy) await delay(2);
  const health = await fetch(base + '/health', { headers, signal: AbortSignal.timeout(1000) });
  assert.equal(health.status, 200);
  const response = await pending; assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'first_token_timeout');
  await workers[0].termination;
  assert.equal(workers[0].closed, true); assert.equal(engine.busy, false);
  // The intentionally tiny deadline above proves cancellation. A fresh healthy
  // worker needs normal scheduling headroom when all integration files run at once.
  settings.firstTokenTimeoutMs = 3000; settings.requestTimeoutMs = 5000;
  const next = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(basic()) });
  assert.equal(next.status, 200); assert.equal((await next.json()).choices[0].message.content, 'turn-1');
});
