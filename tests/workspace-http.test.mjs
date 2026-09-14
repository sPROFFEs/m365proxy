import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProxyEngine } from '../src/engine.mjs';
import { createProxyServer } from '../src/server.mjs';
import { WorkspaceManager } from '../src/workspace.mjs';
import { workspaceCommand } from '../src/workspace-cli.mjs';
import { fakeCore, fakeAuth, basic, streamOf, toolRequest } from './helpers.mjs';
import { treeFixture } from './workspace-helpers.mjs';
import { getApiKey } from '../src/util.mjs';
const KEY = 'c'.repeat(64);
const HEADERS = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const PATCH = '--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n';
const answer = '```diff\n' + PATCH + '```\n';
async function fixture(t, mode = 'read', respond = () => streamOf('OK')) {
  const f = await treeFixture(t, undefined, { contextMode: mode });
  f.manager.key = KEY;
  let calls = 0; const prompts = [];
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: f.settings, workspace: f.manager,
    factory: () => ({ reset() {}, run: async (prompt) => { calls++; prompts.push(prompt); return respond(prompt); } }) });
  const server = createProxyServer({ engine, apiKey: KEY, config: f.settings });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { engine.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return { ...f, engine, server, prompts, calls: () => calls, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, path, body, headers = HEADERS) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

test('HTTP context inspection requires auth and returns metadata without an upstream request', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/local/workspaces')).status, 401);
  const context = await post(f.base, '/local/context', { query: 'app' }); const data = await context.json();
  assert.equal(context.status, 200); assert.equal(data.sent_to_microsoft, false); assert.ok(data.selected_files.length);
  assert.ok(!JSON.stringify(data).includes('const value')); assert.equal(f.calls(), 0);
});
test('a request cannot register an arbitrary directory or disagree with a project prefix', async (t) => {
  const f = await fixture(t);
  assert.equal((await post(f.base, '/local/context', { root: '/etc' })).status, 400);
  assert.equal((await post(f.base, '/projects/not-registered/v1/chat/completions', basic())).status, 404);
  assert.equal((await post(f.base, '/projects/default/v1/chat/completions', basic(), { ...HEADERS, 'X-M365-Project': 'other' })).status, 400);
  assert.equal(f.calls(), 0);
});
test('read-mode chat injects a fresh snapshot and reports its manifest', async (t) => {
  const f = await fixture(t);
  const res = await post(f.base, '/projects/default/v1/chat/completions', basic()); const data = await res.json();
  assert.equal(res.status, 200); assert.match(f.prompts[0], /const value = 1;/);
  assert.equal(data.x_m365.workspace.sync, 'rescan_per_request'); assert.equal(data.x_m365.workspace.proposal, null);
  assert.equal(data.x_m365.session_reused, false); assert.equal(f.engine.sessions.size, 1);
});
test('source updates change the next prompt while a compatible remote conversation is reused', async (t) => {
  const f = await fixture(t);
  await post(f.base, '/v1/chat/completions', basic()); await writeFile(join(f.dir, 'src/app.js'), 'const value = 9;\n');
  const request = { ...basic(), messages: [...basic().messages, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'again' }] };
  const res = await post(f.base, '/v1/chat/completions', request); assert.equal(res.status, 200);
  assert.match(f.prompts[1], /const value = 9;/); assert.ok(!f.prompts[1].includes('const value = 1;'));
  assert.equal((await res.json()).x_m365.session_reused, true);
});
test('read mode preserves the native tool schema rather than silently removing it', async (t) => {
  const f = await fixture(t, 'read'); const body = { ...toolRequest(), tool_choice: 'auto' };
  const res = await post(f.base, '/v1/chat/completions', body); assert.equal(res.status, 200);
  assert.match(f.prompts[0], /"name":"echo"/); assert.match(f.prompts[0], /LOCAL WORKSPACE SNAPSHOT/);
});
test('patch mode rejects active tools and tool history before contacting Microsoft', async (t) => {
  const f = await fixture(t, 'patch');
  const res = await post(f.base, '/v1/chat/completions', toolRequest());
  assert.equal(res.status, 400); assert.equal((await res.json()).error.code, 'patch_mode_tools_not_allowed'); assert.equal(f.calls(), 0);
});
test('patch mode accepts explicitly inactive tools and returns a signed proposal, not tool_calls', async (t) => {
  const f = await fixture(t, 'patch', () => streamOf(answer));
  const res = await post(f.base, '/v1/chat/completions', { ...toolRequest(), tool_choice: 'none' }); const data = await res.json();
  assert.equal(res.status, 200); assert.equal(data.choices[0].finish_reason, 'stop'); assert.equal(data.choices[0].message.tool_calls, undefined);
  assert.equal(data.x_m365.workspace.proposal.applied, false); assert.equal(data.x_m365.workspace.proposal.patch, PATCH);
  assert.match(f.prompts[0], /PATCH PROPOSAL MODE/);
  const check = await post(f.base, '/local/patch/check', data.x_m365.workspace.proposal); assert.equal(check.status, 200);
  assert.equal(await readFile(join(f.dir, 'src/app.js'), 'utf8'), 'const value = 1;\n');
});
for (const protocol of ['chat', 'responses', 'ollama']) {
  test(`patch output is buffered and finalized once on ${protocol}`, async (t) => {
    const f = await fixture(t, 'patch', () => streamOf(answer));
    const path = protocol === 'responses' ? '/v1/responses' : protocol === 'ollama' ? '/api/chat' : '/v1/chat/completions';
    const body = protocol === 'responses' ? { model: 'm365-copilot', input: 'edit app', stream: true } : { ...basic(), stream: true };
    const res = await post(f.base, path, body); const data = await res.text(); assert.equal(res.status, 200);
    assert.ok(data.includes('m365proxy.patch.v1'));
    if (protocol === 'responses') assert.equal(data.match(/event: response.completed/g)?.length, 1);
    else if (protocol === 'ollama') assert.equal(data.trim().split('\n').map(JSON.parse).filter((x) => x.done === true).length, 1);
    else assert.equal(data.match(/data: \[DONE\]/g)?.length, 1);
    assert.equal(await readFile(join(f.dir, 'src/app.js'), 'utf8'), 'const value = 1;\n');
  });
}
test('an invalid streamed patch is a JSON HTTP error, not a partial successful diff', async (t) => {
  const f = await fixture(t, 'patch', () => streamOf(answer.replace('-const value = 1;', '-not the source')));
  const res = await post(f.base, '/v1/chat/completions', { ...basic(), stream: true });
  assert.equal(res.status, 502); assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal((await res.json()).error.code, 'patch_contract_error'); assert.equal(f.engine.busy, false);
});
test('workspace endpoints keep Origin and Host defenses', async (t) => {
  const f = await fixture(t);
  assert.equal((await post(f.base, '/local/context', {}, { ...HEADERS, Origin: 'https://example.invalid' })).status, 403);
});
test('failed scan does not hold the engine busy or send a prompt', async (t) => {
  const f = await fixture(t); await writeFile(join(f.dir, '.m365ignore'), '*.js\n*.md\n');
  const res = await post(f.base, '/v1/chat/completions', basic()); assert.equal(res.status, 422);
  assert.equal(f.engine.busy, false); assert.equal(f.calls(), 0);
  await writeFile(join(f.dir, '.m365ignore'), ''); assert.equal((await post(f.base, '/v1/chat/completions', basic())).status, 200);
});
test('CLI context preview is local and does not create browser, API key or project output files', async (t) => {
  const f = await treeFixture(t); const before = await readdir(f.dir); const output = [];
  assert.equal(await workspaceCommand('context', { ...f.settings, contextQuery: 'app' }, { output: (x) => output.push(JSON.parse(x)) }), 0);
  assert.equal(output[0].sent_to_microsoft, false); assert.deepEqual(await readdir(f.dir), before);
});
test('CLI propose explicitly exports a 0600 JSON bundle; patch-check never applies it', async (t) => {
  const f = await fixture(t, 'patch', () => streamOf(answer));
  const stateDir = join(f.dir, 'state'); await getApiKey(stateDir); await writeFile(join(stateDir, 'api-key'), KEY + '\n');
  await writeFile(join(f.dir, 'task.txt'), 'Change value from 1 to 2.');
  // Exclude auxiliary fixture files so the snapshot is not a copy of the proxy key.
  await writeFile(join(f.dir, '.m365ignore'), 'state/\ntask.txt\nproposal.json\n');
  const settings = { ...f.settings, workspaceRoot: undefined, stateDir, port: f.server.address().port,
    promptFile: join(f.dir, 'task.txt'), outputFile: join(f.dir, 'proposal.json') };
  const output = []; const options = { output: (x) => output.push(JSON.parse(x)) };
  assert.equal(await workspaceCommand('propose', settings, options), 0);
  assert.equal((await stat(settings.outputFile)).mode & 0o777, 0o600);
  assert.equal((await readFile(join(f.dir, 'src/app.js'), 'utf8')), 'const value = 1;\n');
  assert.equal(await workspaceCommand('patch-check', { ...settings, proposalFile: settings.outputFile }, options), 0);
  assert.equal(output.at(-1).applied, false);
  assert.equal(await workspaceCommand('propose', settings, options), 2); assert.equal(output.at(-1).error.code, 'output_exists');
});
test('multiple registered projects require explicit routing and reject cross-project headers', async (t) => {
  const f = await fixture(t); const other = await treeFixture(t, { 'isolated.js': 'const separate = 1;\n' });
  const registry = join(f.dir, 'registry.json');
  await writeFile(registry, JSON.stringify({ version: 1, projects: [{ id: 'one', root: f.dir }, { id: 'two', root: other.dir }] }));
  f.engine.workspace = await WorkspaceManager.fromConfig({ ...f.settings, workspaceRoot: undefined, workspacesFile: registry }, KEY);
  assert.equal((await post(f.base, '/v1/chat/completions', basic())).status, 400);
  const res = await post(f.base, '/projects/two/v1/chat/completions', basic()); assert.equal(res.status, 200);
  assert.match(f.prompts.at(-1), /const separate = 1;/); assert.ok(!f.prompts.at(-1).includes('const value = 1;'));
});
