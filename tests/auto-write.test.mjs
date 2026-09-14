import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink, link, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { WorkspaceManager } from '../src/workspace.mjs';
import { parseAutoEdits } from '../src/auto-edits.mjs';
import { attachmentName } from '../src/upload-manifest.mjs';
import { config as base, basic, fakeCore, fakeAuth, streamOf, ECHO } from './helpers.mjs';
import { ProxyEngine } from '../src/engine.mjs';
import { sha256 } from '../src/util.mjs';

import { fixture, edits, reply, write, save } from './auto-write-helpers.mjs';

test('automatic write edits, creates and deletes files with receipts and backup/undo', async (t) => {
  const f = await fixture(t, { 'src/main.js': 'const value = 1;\n', 'old.txt': 'old\n' });
  const result = await save(f, [write('src/main.js', 'const value = 2;\n'), write('new/deep/file.py', 'print("new")\n'), { action: 'delete', path: 'old.txt' }]);
  assert.equal(result.applied, true); assert.equal(result.executed_commands, false);
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 2;\n');
  assert.equal(await readFile(join(f.root, 'new/deep/file.py'), 'utf8'), 'print("new")\n');
  await assert.rejects(stat(join(f.root, 'old.txt')), { code: 'ENOENT' });
  const { dir, record } = await f.manager.writer.read(f.project, result.change_id);
  assert.equal(record.status, 'applied'); assert.equal((await stat(join(dir, 'record.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(dir, '0.before'), 'utf8'), 'const value = 1;\n');
  assert.equal((await f.manager.writer.undo(f.project, result.change_id)).restored, true);
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 1;\n');
  assert.equal(await readFile(join(f.root, 'old.txt'), 'utf8'), 'old\n');
  await assert.rejects(stat(join(f.root, 'new/deep/file.py')), { code: 'ENOENT' });
  assert.equal((await f.manager.writer.undo(f.project, result.change_id)).already_restored, true);
});
test('executable bits, CRLF, missing trailing newline and unicode are preserved', async (t) => {
  const f = await fixture(t, { 'script.sh': '#!/bin/sh\r\necho before', 'a.txt': 'a' });
  await chmod(join(f.root, 'script.sh'), 0o755);
  await save(f, [write('script.sh', '#!/bin/sh\r\necho despues'), write('a.txt', 'Hola \u00f1')]);
  assert.equal((await stat(join(f.root, 'script.sh'))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(f.root, 'script.sh'), 'utf8'), '#!/bin/sh\r\necho despues');
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'Hola \u00f1');
});
test('ordinary explanations and code examples never become edits', async (t) => {
  const f = await fixture(t), s = await f.snapshot();
  for (const text of ['He guardado el archivo.', '```js\nconst value = 5;\n```', '```diff\n--- a/src/main.js\n+++ b/src/main.js\n```']) {
    assert.deepEqual(parseAutoEdits(text, s, f.project).changes, []);
  }
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 1;\n');
});
test('strict edit contract rejects wrong snapshot, malformed JSON and multiple blocks', async (t) => {
  const f = await fixture(t), s = await f.snapshot(), block = edits(s, [write('src/main.js', 'changed')]);
  for (const text of [block.replace(s.id, 'wrong'), block + '\n' + block, '```m365-edit\n{}', '```m365-edit\n{invalid}\n```']) assert.throws(() => parseAutoEdits(text, s, f.project), { code: 'edit_contract_error' });
});
test('edit paths cannot traverse, target credentials, use attachment names or execute commands', async (t) => {
  const f = await fixture(t), s = await f.snapshot();
  for (const path of ['../outside.py', '/tmp/outside.py', '.git/hooks/post-commit', '.env', 'src/../../outside.js', attachmentName(s.selected[0]), 4]) {
    assert.throws(() => parseAutoEdits(edits(s, [write(path, 'x')]), s, f.project), { code: 'edit_contract_error' });
  }
  assert.throws(() => parseAutoEdits(edits(s, [{ ...write('src/main.js', 'x'), command: 'touch /tmp/NO' }]), s, f.project), { code: 'edit_contract_error' });
  assert.throws(() => parseAutoEdits(edits(s, [write('src/main.js', 'x'), write('src/main.js', 'y')]), s, f.project), { code: 'edit_contract_error' });
});
test('no-op changes produce no journal or write', async (t) => {
  const f = await fixture(t); const receipt = await save(f, [write('src/main.js', 'const value = 1;\n')]);
  assert.equal(receipt.applied, false); assert.deepEqual(await f.manager.writer.list(f.project), []);
});
test('all target hashes are checked before the first write', async (t) => {
  const f = await fixture(t, { 'a.js': 'a', 'b.js': 'b' }), s = await f.snapshot();
  const plan = parseAutoEdits(edits(s, [write('a.js', 'A'), write('b.js', 'B')]), s, f.project);
  await writeFile(join(f.root, 'b.js'), 'LOCAL EDIT');
  await assert.rejects(f.manager.writer.apply(f.project, s, plan.changes), { code: 'write_base_changed' });
  assert.equal(await readFile(join(f.root, 'a.js'), 'utf8'), 'a'); assert.equal(await readFile(join(f.root, 'b.js'), 'utf8'), 'LOCAL EDIT');
});
test('nonselected existing files cannot be overwritten as new files', async (t) => {
  const f = await fixture(t), s = await f.snapshot(); await writeFile(join(f.root, 'outside-selection.py'), 'KEEP');
  const plan = parseAutoEdits(edits(s, [write('outside-selection.py', 'bad')]), s, f.project);
  await assert.rejects(f.manager.writer.apply(f.project, s, plan.changes), { code: 'write_base_changed' });
  assert.equal(await readFile(join(f.root, 'outside-selection.py'), 'utf8'), 'KEEP');
});
test('symlink and hardlink substitutions never overwrite linked files', async (t) => {
  for (const type of ['symlink', 'hardlink']) {
    const f = await fixture(t), s = await f.snapshot(), target = join(f.dir, 'outside.js');
    await writeFile(target, 'KEEP'); await rm(join(f.root, 'src/main.js'));
    if (type === 'symlink') await symlink(target, join(f.root, 'src/main.js')); else await link(target, join(f.root, 'src/main.js'));
    const plan = parseAutoEdits(edits(s, [write('src/main.js', 'changed')]), s, f.project);
    await assert.rejects(f.manager.writer.apply(f.project, s, plan.changes)); assert.equal(await readFile(target, 'utf8'), 'KEEP');
  }
});
test('new paths cannot follow a symlink parent out of the project', async (t) => {
  const f = await fixture(t); await mkdir(join(f.dir, 'outside')); await symlink(join(f.dir, 'outside'), join(f.root, 'escape'));
  await assert.rejects(save(f, [write('escape/new.js', 'bad')]));
  assert.deepEqual(await readdir(join(f.dir, 'outside')), []);
});
test('a late failure rolls back already saved files and preserves backups', async (t) => {
  const f = await fixture(t, { 'a.js': 'a', 'b.js': 'b' });
  await assert.rejects(save(f, [write('a.js', 'A'), write('b.js', 'B')], { beforeCommit: (i) => { if (i === 1) throw new Error('Synthetic disk failure'); } }), { code: 'write_failed' });
  assert.equal(await readFile(join(f.root, 'a.js'), 'utf8'), 'a'); assert.equal(await readFile(join(f.root, 'b.js'), 'utf8'), 'b');
  assert.equal((await f.manager.writer.list(f.project))[0].status, 'rolled_back');
});
test('cancellation between writes rolls back while still holding admission', async (t) => {
  const f = await fixture(t, { 'a.js': 'a', 'b.js': 'b' }), ctrl = new AbortController();
  await assert.rejects(save(f, [write('a.js', 'A'), write('b.js', 'B')], { signal: ctrl.signal, beforeCommit: (i) => { if (i === 1) ctrl.abort(); } }), { name: 'AbortError' });
  assert.equal(await readFile(join(f.root, 'a.js'), 'utf8'), 'a'); assert.equal((await f.manager.writer.list(f.project))[0].status, 'rolled_back');
});
test('undo refuses later local edits instead of overwriting them', async (t) => {
  const f = await fixture(t), receipt = await save(f, [write('src/main.js', 'edited')]);
  await writeFile(join(f.root, 'src/main.js'), 'THIRD VERSION');
  await assert.rejects(f.manager.writer.undo(f.project, receipt.change_id), { code: 'undo_conflict' });
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'THIRD VERSION');
});
test('tampered backup or record is rejected on undo', async (t) => {
  const f = await fixture(t), receipt = await save(f, [write('src/main.js', 'edited')]);
  const { dir } = await f.manager.writer.read(f.project, receipt.change_id);
  await writeFile(join(dir, '0.before'), 'TAMPERED');
  await assert.rejects(f.manager.writer.undo(f.project, receipt.change_id), { code: 'backup_corrupt' });
  await writeFile(join(dir, 'record.json'), '{}');
  await assert.rejects(f.manager.writer.list(f.project), { code: 'journal_corrupt' });
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'edited');
});
test('root directory flock blocks a cooperating second writer even in another state directory', async (t) => {
  const f = await fixture(t), state2 = join(f.dir, 'state2');
  const other = await WorkspaceManager.fromConfig({ ...f.config, stateDir: state2 }, 'another-key');
  const s = await f.snapshot(), plan = parseAutoEdits(edits(s, [write('src/main.js', 'A')]), s, f.project);
  let unblock, entered; const started = new Promise((r) => entered = r);
  const first = f.manager.writer.apply(f.project, s, plan.changes, { beforeCommit: async () => { entered(); await new Promise((r) => unblock = r); } });
  await started;
  try { await assert.rejects(other.writer.apply(other.select(), s, plan.changes), { code: 'workspace_write_busy' }); }
  finally { unblock(); await first; }
});
test('auto mode owns writes and ignores offered CLI tools only when explicitly enabled', async (t) => {
  const f = await fixture(t); const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: f.config, workspace: f.manager,
    factory: () => ({ reset() {}, async run(prompt) { return streamOf(reply(prompt, [write('src/main.js', 'const value = 3;\n')])); } }) });
  t.after(() => engine.close());
  const deltas = []; const result = await engine.run(engine.validate({ ...basic(), tools: [ECHO], tool_choice: 'required' }), { onDelta: (x) => deltas.push(x) });
  assert.deepEqual(deltas, []); assert.equal(result.choices[0].message.tool_calls, undefined);
  assert.equal(result.x_m365.workspace.write.applied, true); assert.match(result.choices[0].message.content, /Cambios guardados/);
  assert.ok(!result.choices[0].message.content.includes('```m365-edit'));
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 3;\n');
});
test('persistent replay returns a write receipt after restart without running Copilot twice', async (t) => {
  const f = await fixture(t); let count = 0;
  const create = (manager) => new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: f.config, workspace: manager,
    factory: () => ({ reset() {}, async run(prompt) { count++; return streamOf(reply(prompt, [write('src/main.js', 'const value = 4;\n')])); } }) });
  const engine = create(f.manager); t.after(() => engine.close());
  await engine.run(engine.validate(basic()), { idempotencyKey: 'same-request' });
  const other = create(await WorkspaceManager.fromConfig(f.config, 'test-key-'.repeat(8))); t.after(() => other.close());
  const response = await other.run(other.validate(basic()), { idempotencyKey: 'same-request' });
  assert.equal(count, 1); assert.equal(response.x_m365.workspace.write.replayed, true);
  await assert.rejects(other.run(other.validate({ ...basic(), messages: [{ role: 'user', content: 'different' }] }), { idempotencyKey: 'same-request' }), { code: 'idempotency_conflict' });
});
test('latest ignore rules are rechecked before finalization', async (t) => {
  const f = await fixture(t), engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: f.config, workspace: f.manager,
    factory: () => ({ reset() {}, async run(prompt) { await writeFile(join(f.root, '.m365ignore'), 'src/main.js\n'); return streamOf(reply(prompt, [write('src/main.js', 'BAD')])); } }) });
  t.after(() => engine.close());
  await assert.rejects(engine.run(engine.validate(basic())), { code: 'write_policy_changed' });
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 1;\n');
});

test('automatic write can create a real empty directory without placeholder files', async (t) => {
  const f = await fixture(t);
  const s = await f.snapshot();
  const plan = parseAutoEdits(edits(s, [{ action: 'mkdir', path: 'output' }]), s, f.project);
  assert.deepEqual(plan.changes, [{ kind: 'directory', operation: 'mkdir', path: 'output' }]);
  const receipt = await f.manager.writer.apply(f.project, s, plan.changes, { requestFingerprint: sha256('mkdir-output') });
  assert.equal(receipt.applied, true);
  assert.equal(receipt.files[0].action, 'created_directory');
  assert.equal((await stat(join(f.root, 'output'))).isDirectory(), true);
  assert.deepEqual(await readdir(join(f.root, 'output')), []);
  await f.manager.writer.undo(f.project, receipt.change_id);
  await assert.rejects(stat(join(f.root, 'output')), { code: 'ENOENT' });
});

test('empty .gitkeep model workaround is normalized to a real mkdir', async (t) => {
  const f = await fixture(t);
  const s = await f.snapshot();
  const plan = parseAutoEdits(edits(s, [write('output/.gitkeep', '')]), s, f.project);
  assert.deepEqual(plan.changes, [{ kind: 'directory', operation: 'mkdir', path: 'output' }]);
  const receipt = await f.manager.writer.apply(f.project, s, plan.changes, { requestFingerprint: sha256('compat-gitkeep') });
  assert.equal((await stat(join(f.root, 'output'))).isDirectory(), true);
  await assert.rejects(stat(join(f.root, 'output', '.gitkeep')), { code: 'ENOENT' });
  await f.manager.writer.undo(f.project, receipt.change_id);
});

test('mkdir respects protected and ignored directory policy', async (t) => {
  const f = await fixture(t);
  const s = await f.snapshot();
  for (const path of ['.git', 'node_modules', '../outside', '/tmp/outside']) {
    assert.throws(() => parseAutoEdits(edits(s, [{ action: 'mkdir', path }]), s, f.project), { code: 'edit_contract_error' });
  }
});

test('undo never recursively deletes content added later to an auto-created directory', async (t) => {
  const f = await fixture(t);
  const s = await f.snapshot();
  const plan = parseAutoEdits(edits(s, [{ action: 'mkdir', path: 'output' }]), s, f.project);
  const receipt = await f.manager.writer.apply(f.project, s, plan.changes, { requestFingerprint: sha256('mkdir-conflict') });
  await writeFile(join(f.root, 'output', 'keep.txt'), 'local data');
  await assert.rejects(f.manager.writer.undo(f.project, receipt.change_id), { code: 'undo_conflict' });
  assert.equal(await readFile(join(f.root, 'output', 'keep.txt'), 'utf8'), 'local data');
});
