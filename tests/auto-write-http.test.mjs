import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createProxyServer } from '../src/server.mjs';
import { ProxyEngine } from '../src/engine.mjs';
import { changeCommand } from '../src/change-cli.mjs';
import { basic, fakeCore, fakeAuth, streamOf, ECHO } from './helpers.mjs';
import { fixture, edits, reply, write } from './auto-write-helpers.mjs';
import { delay } from '../src/util.mjs';

async function live(t, { mode = 'hybrid', answer, queue = 4 } = {}) {
  const f = await fixture(t, { 'src/main.js': 'const value = 1;\n' }, { contextMode: mode, queueMaxPending: queue, queueWaitMs: 5000 });
  let calls = 0;
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: f.config, workspace: f.manager,
    upload: { status: () => ({ enabled: true }), async run({ snapshot, signal }) {
      calls++; await delay(15, signal);
      return { text: answer ? answer(snapshot) : edits(snapshot, [write('src/main.js', 'const value = 9;\n')]), metadata: { uploaded_files: true, same_page_turn: true } };
    } },
    factory: () => ({ reset() {}, async run(prompt) { calls++; return streamOf(reply(prompt, [write('src/main.js', 'const value = 9;\n')])); } }) });
  const key = 'test-key-'.repeat(8); await writeFile(join(f.state, 'api-key'), key);
  const server = createProxyServer({ engine, apiKey: key, config: f.config });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, baseURL = `http://127.0.0.1:${port}`;
  t.after(async () => { engine.close(); await engine.drain(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const request = (path, body, headers = {}, signal) => fetch(baseURL + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
  return { ...f, engine, port, request, calls: () => calls };
}
test('upload, local write and one final Chat SSE receipt form a complete circuit', async (t) => {
  const f = await live(t);
  const res = await f.request('/v1/chat/completions', { ...basic(), tools: [ECHO], stream: true });
  assert.equal(res.status, 200); const text = await res.text();
  assert.equal(text.split('data: [DONE]').length - 1, 1); assert.match(text, /Cambios guardados/); assert.match(text, /"applied":true/);
  assert.ok(!text.includes('```m365-edit')); assert.ok(!text.includes('"tool_calls":['));
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 9;\n');
});
test('Responses and native Ollama finalize after saving rather than before', async (t) => {
  for (const [path, body, terminal] of [
    ['/v1/responses', { model: 'm365-copilot', input: 'change it', stream: true }, 'event: response.completed'],
    ['/api/chat', { ...basic(), stream: true }, '"done":true'],
  ]) {
    const f = await live(t); const res = await f.request(path, body); assert.equal(res.status, 200);
    const text = await res.text(); assert.equal(text.split(terminal).length - 1, 1); assert.match(text, /Cambios guardados/);
    assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 9;\n');
  }
});
test('identical concurrent retries are queued then replayed without a second upload or write', async (t) => {
  const f = await live(t), payload = { ...basic() };
  const replies = await Promise.all([f.request('/v1/chat/completions', payload), f.request('/v1/chat/completions', payload)]);
  assert.deepEqual(replies.map((r) => r.status), [200, 200]);
  const values = await Promise.all(replies.map((r) => r.json()));
  assert.equal(f.calls(), 1); assert.equal(values.filter((r) => r.x_m365.workspace.write.replayed).length, 1);
  assert.equal((await (await f.request('/local/changes')).json()).changes.length, 1);
});
test('a malformed edit is a JSON error before SSE, with no source write', async (t) => {
  const f = await live(t, { answer: () => '```m365-edit\n{broken}\n```' });
  const res = await f.request('/v1/chat/completions', { ...basic(), stream: true });
  assert.equal(res.status, 422); assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 1;\n');
});
test('changes and undo CLI need no Microsoft token or per-change dialog', async (t) => {
  const f = await live(t); await (await f.request('/v1/chat/completions', basic())).json();
  const log = [], cfg = { ...f.config, port: f.port };
  assert.equal(await changeCommand('changes', cfg, { output: (s) => log.push(s) }), 0);
  const changeId = JSON.parse(log.at(-1)).changes[0].change_id;
  f.engine.auth.status = () => ({ state: 'authentication_required' });
  assert.equal(await changeCommand('undo', { ...cfg, changeId }, { output: (s) => log.push(s) }), 0);
  assert.equal(JSON.parse(log.at(-1)).restored, true);
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 1;\n');
});
test('ask CLI saves directly through a running auto workspace', async (t) => {
  const f = await live(t), out = [];
  assert.equal(await changeCommand('ask', { ...f.config, port: f.port, contextQuery: 'Set value to 9' }, { output: (s) => out.push(s) }), 0);
  assert.match(out.join('\n'), /Cambios guardados/);
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 9;\n');
});
test('auto mode refuses prior CLI tool history, requiring a fresh conversation', async (t) => {
  const f = await live(t);
  const messages = [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'echo', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'done' }];
  const res = await f.request('/v1/chat/completions', { ...basic(), messages });
  assert.equal(res.status, 400); assert.equal((await res.json()).error.code, 'auto_write_tool_history'); assert.equal(f.calls(), 0);
});
test('client cancellation while waiting never starts another upload', async (t) => {
  const f = await live(t); let unblock;
  f.engine.upload.run = async ({ snapshot }) => { await new Promise((r) => unblock = r); return { text: edits(snapshot, [write('src/main.js', 'x')]) }; };
  const first = f.request('/v1/chat/completions', basic());
  while (!unblock) await delay(2);
  const ctrl = new AbortController();
  const second = f.request('/v1/chat/completions', { ...basic(), messages: [{ role: 'user', content: 'second' }] }, {}, ctrl.signal);
  while (!f.engine.health().queue.pending) await delay(2);
  ctrl.abort(); await assert.rejects(second);
  for (let i = 0; i < 50 && f.engine.health().queue.pending; i++) await delay(2);
  assert.equal(f.engine.health().queue.pending, 0); unblock(); assert.equal((await first).status, 200);
});
test('edit endpoints reject arbitrary paths and still enforce local authentication', async (t) => {
  const f = await live(t);
  assert.equal((await f.request('/local/changes', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.request('/local/changes/undo', { change_id: '../outside', root: '/' })).status, 400);
  assert.equal((await f.request('/local/changes/undo', { change_id: '../outside' })).status, 400);
});

test('folder-only request compatibility no longer fails on empty .gitkeep workaround', async (t) => {
  const f = await live(t, { answer: (snapshot) => edits(snapshot, [write('output/.gitkeep', '')]) });
  const res = await f.request('/v1/chat/completions', { ...basic(), messages: [{ role: 'user', content: 'crea una carpeta llamada output' }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.x_m365.workspace.write.applied, true);
  assert.equal(body.x_m365.workspace.write.files[0].action, 'created_directory');
  assert.equal((await stat(join(f.root, 'output'))).isDirectory(), true);
  await assert.rejects(stat(join(f.root, 'output', '.gitkeep')), { code: 'ENOENT' });
});
