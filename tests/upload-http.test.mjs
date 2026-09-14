import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProxyEngine } from '../src/engine.mjs';
import { createProxyServer } from '../src/server.mjs';
import { WorkspaceManager } from '../src/workspace.mjs';
import { readConfig } from '../src/config.mjs';
import { ProxyError } from '../src/errors.mjs';
import { fakeCore, fakeAuth, basic, toolRequest, envelope } from './helpers.mjs';
import { treeFixture } from './workspace-helpers.mjs';
const KEY = 'c'.repeat(64), HEADERS = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const post = (f, path, body) => fetch(f.base + path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
async function fixture(t, mode = 'hybrid', respond, overrides = {}) {
  const f = await treeFixture(t, undefined, { contextMode: mode, ...overrides }); const calls = [];
  const upload = { status: () => ({ enabled: true }), run: async (data) => {
    calls.push(data); data.onPhase('sending_browser_prompt'); data.onText('O');
    return { text: respond ? respond(data) : 'OK', metadata: { uploaded_files: true, same_page_turn: true, output_buffered: true, cache_reused: false, transport: 'browser_owned_turn' } };
  } };
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: f.settings, workspace: f.manager, upload,
    factory: () => { throw new Error('Upload mode must not create a disconnected cramt conversation.'); } });
  const server = createProxyServer({ engine, apiKey: KEY, config: f.settings }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { engine.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return { ...f, engine, upload, calls, base: `http://127.0.0.1:${server.address().port}` };
}
test('upload and hybrid modes have bounded defaults and prompt alias preserves read', () => {
  assert.equal(readConfig(['--context-mode', 'prompt'], {}).contextMode, 'read');
  for (const mode of ['upload', 'hybrid']) {
    const c = readConfig(['--context-mode', mode, '--workspace', '/tmp/project'], {});
    assert.equal(c.requestTimeoutMs, 240000); assert.equal(c.uploadMaxFiles, 5); assert.equal(c.uploadMaxFileBytes, 1048576);
  }
  for (const args of [['--upload-max-files', '0'], ['--upload-max-file-size', '99999999'], ['--context-mode', 'random']]) assert.throws(() => readConfig(args, {}));
});
test('upload mode cannot be configured without a workspace', async () => {
  await assert.rejects(WorkspaceManager.fromConfig(readConfig(['--context-mode', 'upload'], {})), { code: 'invalid_request' });
});
test('upload context has no source text and respects ignores/secrets and separate byte limits', async (t) => {
  const f = await treeFixture(t, { 'big.js': '// marker\n' + 'let x = 0;\n'.repeat(4000), '.env': 'password=hidden', 'skip.js': 'do not send', '.m365ignore': 'skip.js\n' }, { contextMode: 'upload', uploadMaxFileBytes: 1048576 });
  const snapshot = await f.manager.snapshot(undefined, 'marker');
  assert.equal(snapshot.selected.length, 1); assert.equal(snapshot.selected[0].path, 'big.js');
  assert.ok(!snapshot.prompt.includes('let x = 0;')); assert.ok(snapshot.summary.context_bytes < 4096);
  assert.ok(snapshot.summary.planned_upload_bytes > 32768); assert.equal(snapshot.summary.uploaded_files, false);
});
test('Chat upload uses browser transport, not cramt ModelSession or source injection', async (t) => {
  const f = await fixture(t); const r = await post(f, '/v1/chat/completions', basic()); const data = await r.json();
  assert.equal(r.status, 200); assert.equal(data.choices[0].message.content, 'OK');
  assert.ok(!f.calls[0].prompt.includes('const value = 1;')); assert.ok(f.calls[0].snapshot.selected.some((s) => s.text.includes('const value')));
  assert.equal(data.x_m365.workspace.uploaded_files, true); assert.equal(data.x_m365.workspace.proposal, null);
  assert.equal(data.x_m365.upstream_model_route, 'copilot_web_default'); assert.equal(f.engine.sessions.size, 0);
});


test('upload mode reuses one logical browser conversation for an exact client-history continuation', async (t) => {
  const f = await fixture(t);
  const first = await post(f, '/v1/chat/completions', basic()); const one = await first.json();
  assert.equal(one.x_m365.session_reused, false); assert.equal(f.engine.uploadSessions.size, 1);
  const secondBody = { ...basic(), messages: [...basic().messages, one.choices[0].message, { role: 'user', content: 'Continue' }] };
  const second = await post(f, '/v1/chat/completions', secondBody); const two = await second.json();
  assert.equal(second.status, 200); assert.equal(two.x_m365.session_reused, true); assert.equal(f.engine.uploadSessions.size, 1);
  assert.equal(f.calls[0].reused, false); assert.equal(f.calls[1].reused, true);
  assert.match(f.calls[1].prompt, /Continue/); assert.ok(!f.calls[1].prompt.includes('"content":"Hello"'));
});



test('browser reuse has a sticky fallback for clients that send only the current turn', async (t) => {
  const f = await fixture(t);
  const first = await post(f, '/v1/chat/completions', basic()); const one = await first.json();
  const second = await post(f, '/v1/chat/completions', { ...basic(), messages: [{ role: 'user', content: 'Second stateless turn' }] }); const two = await second.json();
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(one.x_m365.session_reused, false);
  assert.equal(two.x_m365.session_reused, true);
  assert.equal(two.x_m365.session_reuse_reason, 'sticky');
  assert.equal(f.engine.uploadSessions.size, 1);
  assert.equal(f.calls[1].reused, true);
  assert.match(f.calls[1].prompt, /Second stateless turn/);
});
test('conversation-mode fresh preserves the old one-remote-chat-per-request behavior', async (t) => {
  const f = await fixture(t, 'hybrid', undefined, { conversationMode: 'fresh' });
  const first = await post(f, '/v1/chat/completions', basic()); const one = await first.json();
  const secondBody = { ...basic(), messages: [...basic().messages, one.choices[0].message, { role: 'user', content: 'Continue' }] };
  const second = await post(f, '/v1/chat/completions', secondBody); const two = await second.json();
  assert.equal(two.x_m365.session_reused, false);
});
test('SSE upload ends once and does not emit progress/duplicate final contents', async (t) => {
  const f = await fixture(t); const r = await post(f, '/v1/chat/completions', { ...basic(), stream: true }); const text = await r.text();
  assert.equal(r.status, 200); assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
  assert.equal((text.match(/"content":"OK"/g) ?? []).length, 1); assert.ok(!text.includes('"content":"O"'));
});
test('Responses and Ollama remain distinct buffered protocols in upload mode', async (t) => {
  const f = await fixture(t);
  const r = await post(f, '/v1/responses', { model: 'm365-copilot', input: 'Hello', stream: true }); const text = await r.text();
  assert.equal(r.status, 200); assert.ok(text.includes('response.completed')); assert.ok(!text.includes('const value'));
  const q = await post(f, '/api/chat', { ...basic(), stream: true }); const lines = (await q.text()).trim().split('\n').map(JSON.parse);
  assert.equal(q.status, 200); assert.equal(lines.filter((p) => p.done === true).length, 1);
});
test('emulated tool calls still pass through the same validator with attached files', async (t) => {
  const f = await fixture(t, 'upload', (d) => envelope(d.prompt));
  const r = await post(f, '/v1/chat/completions', toolRequest()); const data = await r.json();
  assert.equal(r.status, 200); assert.equal(data.choices[0].finish_reason, 'tool_calls');
  assert.equal(data.choices[0].message.tool_calls[0].function.name, 'echo');
});
test('upload errors never silently send context through a second transport; engine recovers', async (t) => {
  const f = await fixture(t); const original = f.upload.run;
  f.upload.run = async () => { throw new ProxyError(422, 'upload_input_missing', 'Missing uploader'); };
  const r = await post(f, '/v1/chat/completions', { ...basic(), stream: true });
  assert.equal(r.status, 422); assert.equal((await r.json()).error.code, 'upload_input_missing'); assert.equal(f.engine.busy, false);
  f.upload.run = original; assert.equal((await post(f, '/v1/chat/completions', basic())).status, 200);
});
test('changed/deleted sources generate a new upload selection instead of cached old attachment claims', async (t) => {
  const f = await fixture(t); await post(f, '/v1/chat/completions', basic());
  const first = f.calls[0].snapshot.id; await writeFile(join(f.dir, 'src/app.js'), 'const value = 7;\n');
  const r = await post(f, '/v1/chat/completions', basic()); assert.equal(r.status, 200);
  assert.notEqual(f.calls[1].snapshot.id, first); assert.ok(f.calls[1].snapshot.selected.some((s) => s.text.includes('value = 7')));
  assert.equal(await readFile(join(f.dir, 'src/app.js'), 'utf8'), 'const value = 7;\n');
});
test('a mere local context preview does not upload or start a browser', async (t) => {
  const f = await fixture(t); const r = await post(f, '/local/context', { query: 'app' }); const body = await r.json();
  assert.equal(r.status, 200); assert.equal(body.uploaded_files, false); assert.equal(body.sent_to_microsoft, false); assert.equal(f.calls.length, 0);
});

test('hybrid inventory-only questions reach Copilot without any selected upload file', async (t) => {
  const f = await fixture(t, 'hybrid', undefined, {});
  await writeFile(join(f.dir, 'README.md'), '');
  const r = await post(f, '/v1/chat/completions', { ...basic(), messages: [{ role: 'user', content: 'cuantos archivos hay en el workspace' }] });
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].snapshot.metadataOnly, true);
  assert.equal(f.calls[0].snapshot.selected.length, 0);
  assert.equal(f.calls[0].snapshot.allowEmpty, true);
  assert.match(f.calls[0].prompt, /eligible_source_files/);
  assert.equal(data.choices[0].message.content, 'OK');
});
