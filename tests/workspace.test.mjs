import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../src/config.mjs';
import { SafeTree, validRelative, parseIgnore, ignored, protectedPath } from '../src/workspace-files.mjs';
import { WorkspaceManager } from '../src/workspace.mjs';
import { basic, config } from './helpers.mjs';
import { treeFixture } from './workspace-helpers.mjs';

test('workspace is opt-in; config accepts relative caller cwd and rejects conflicting roots', async () => {
  assert.equal(readConfig([], {}).workspaceRoot, undefined);
  assert.equal(readConfig(['--workspace', '.'], {}).workspaceRoot, process.cwd());
  assert.throws(() => readConfig(['--workspace', '.', '--workspaces', 'a.json'], {}));
  assert.throws(() => readConfig(['--context-mode', 'exec'], {}));
  assert.throws(() => readConfig(['--context-max-files', '0'], {}));
  assert.equal((await WorkspaceManager.fromConfig({})).select(), null);
  await assert.rejects(WorkspaceManager.fromConfig({ contextMode: 'patch' }), { code: 'invalid_request' });
});
test('unsafe roots and relative path traversal are rejected', async () => {
  await assert.rejects(SafeTree.create('/'), { code: 'workspace_root_denied' });
  for (const p of ['../a', '/tmp/a', 'x/../../a', 'x//a', 'a\\b', 'c:a', 'x/./a', 'a\x1b.js']) assert.equal(validRelative(p), false);
  for (const p of ['.env', '.env.local', '.ssh/id_rsa', 'config/secrets.json', 'browser-profile/file.js', '.m365proxy-tmp/step.sh']) assert.equal(protectedPath(p), true);
});
test('small UTF-8 source tree is provided as complete files with hashes, not host paths', async (t) => {
  const { dir, manager } = await treeFixture(t);
  const a = await manager.snapshot(undefined, 'app');
  assert.equal(a.selected.length, 2); assert.ok(a.prompt.includes('const value = 1;'));
  assert.ok(!a.prompt.includes(dir)); assert.equal(a.summary.context_bytes, Buffer.byteLength(a.prompt));
  assert.ok(a.selected.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)));
  assert.equal(a.id, (await manager.snapshot(undefined, 'app')).id);
});
test('file modifications, deletions and additions are visible on the next snapshot', async (t) => {
  const { dir, manager } = await treeFixture(t);
  const old = await manager.snapshot(); await writeFile(join(dir, 'src/app.js'), 'const value = 2;\n');
  const updated = await manager.snapshot(); assert.notEqual(old.id, updated.id);
  assert.ok(updated.prompt.includes('const value = 2;')); assert.ok(!updated.prompt.includes('const value = 1;'));
  await rm(join(dir, 'src/app.js')); await writeFile(join(dir, 'src/new.js'), 'export const fresh = true;\n');
  const next = await manager.snapshot(); assert.ok(!next.prompt.includes('src/app.js')); assert.ok(next.prompt.includes('src/new.js'));
});
test('gitignore and nested rules are honored even for source-like files', async (t) => {
  const { manager } = await treeFixture(t, { '.gitignore': 'private/\n*.tmp.js\n!keep.tmp.js\n', 'private/a.js': 'HIDDEN',
    'hidden.tmp.js': 'HIDDEN', 'keep.tmp.js': 'KEEP', 'src/.gitignore': 'secret.js\n', 'src/secret.js': 'HIDDEN', 'src/public.js': 'PUBLIC' });
  const snap = await manager.snapshot(); assert.deepEqual(snap.selected.map((f) => f.path).sort(), ['keep.tmp.js', 'src/public.js']);
  assert.ok(!snap.prompt.includes('HIDDEN'));
});
test('.m365ignore overrides nested reinclusion and cannot reinclude builtin secret files', async (t) => {
  const { manager } = await treeFixture(t, { '.m365ignore': 'src/private.js\n!.env\n', '.env': 'SECRET',
    'src/.gitignore': '!private.js\n', 'src/private.js': 'SECRET', 'src/public.js': 'PUBLIC' });
  const snap = await manager.snapshot(); assert.equal(snap.selected.length, 1); assert.equal(snap.selected[0].path, 'src/public.js');
});
test('ignore parser supports anchored rules, globstar, classes, escaped comment and negation', () => {
  const rules = parseIgnore('/top.js\n**/temp?.[jt]s\n\\#note.md\n*.js\n!keep.js\n');
  assert.equal(ignored('deep/temp1.ts', false, rules), true);
  assert.equal(ignored('#note.md', false, rules), true);
  assert.equal(ignored('keep.js', false, rules), false);
  assert.equal(ignored('deep/top.txt', false, rules), false);
  assert.throws(() => parseIgnore('[[:alpha:]].js'), { code: 'workspace_ignore_pattern' });
  assert.throws(() => parseIgnore('broken\\'), { code: 'workspace_ignore_pattern' });
});
test('ignored parents cannot be reintroduced by a child exception', async (t) => {
  const { manager } = await treeFixture(t, { '.gitignore': 'hidden/\n!hidden/keep.js\n', 'hidden/keep.js': 'NO', 'visible.js': 'YES' });
  const snap = await manager.snapshot(); assert.deepEqual(snap.selected.map((f) => f.path), ['visible.js']);
});
test('unsafe/malformed ignore files fail closed', async (t) => {
  const { dir, manager } = await treeFixture(t, { '.gitignore': '[malformed', 'app.js': 'data' });
  await assert.rejects(manager.snapshot(), { code: 'workspace_ignore_unreadable' });
  await rm(join(dir, '.gitignore')); await symlink('/etc/passwd', join(dir, '.gitignore'));
  await assert.rejects(manager.snapshot(), { code: 'workspace_ignore_unreadable' });
});
test('symlinks and hard links cannot export files outside the project', async (t) => {
  const { dir, manager } = await treeFixture(t);
  await symlink('/etc/passwd', join(dir, 'external.js'));
  await symlink('/etc', join(dir, 'external-dir'));
  await link(join(dir, 'src/app.js'), join(dir, 'hardlinked.js'));
  const snap = await manager.snapshot(); assert.deepEqual(snap.selected.map((f) => f.path), ['README.md']);
  assert.ok(!snap.prompt.includes('root:'));
});
test('a symlink swapped into a parent directory is not followed', async (t) => {
  const { dir, project } = await treeFixture(t);
  await rename(join(dir, 'src'), join(dir, 'old-src')); await symlink('/etc', join(dir, 'src'));
  await assert.rejects(project.tree.read('src/passwd'));
});
test('a replaced root directory is rejected by its filesystem identity', async (t) => {
  const { dir, project } = await treeFixture(t); const moved = dir + '-moved';
  t.after(() => rm(moved, { recursive: true, force: true }));
  await rename(dir, moved); await mkdir(dir); await writeFile(join(dir, 'app.js'), 'OTHER');
  await assert.rejects(project.tree.read('app.js'), { code: 'workspace_root_changed' });
});
test('binary data, oversized files and common credentials are excluded without returning their paths', async (t) => {
  const { manager } = await treeFixture(t, { 'binary.js': Buffer.from([0, 255, 1]), 'large.js': 'x'.repeat(40000),
    '.env.local': 'SHOULD_NOT_APPEAR', 'settings.js': 'const password = "secret-example-long";\n', 'app.js': 'const safe = 1;\n' });
  const snap = await manager.snapshot(); assert.deepEqual(snap.selected.map((f) => f.path), ['app.js']);
  assert.equal(snap.summary.skipped.secret_heuristic, 1); assert.equal(snap.summary.skipped.binary, 1);
  assert.equal(snap.summary.skipped.oversized, 1); assert.ok(!snap.prompt.includes('settings.js'));
});
test('configured proxy state nested inside the project is excluded', async (t) => {
  const f = await treeFixture(t, { 'app.js': 'x', 'state/unusual.json': 'PRIVATE' });
  const manager = await WorkspaceManager.fromConfig({ ...f.settings, stateDir: join(f.dir, 'state') });
  const snap = await manager.snapshot(); assert.ok(!snap.prompt.includes('PRIVATE'));
});
test('context size is a hard byte budget including JSON overhead and never truncates a file', async (t) => {
  const content = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`file${i}.js`, '// ' + '\u00e9'.repeat(800) + '\n']));
  const { manager } = await treeFixture(t, content, { contextMaxBytes: 4096, contextMaxFiles: 2 });
  const snap = await manager.snapshot(); assert.ok(snap.summary.context_bytes <= 4096);
  assert.ok(snap.selected.length <= 2); assert.equal(snap.summary.partial, true);
  assert.ok(snap.selected.every((f) => f.text === content[f.path]));
});
test('adaptive generic questions can omit an empty workspace, but source requests still fail explicitly', async (t) => {
  const { manager } = await treeFixture(t, { '.env': 'PRIVATE' }, { contextPolicy: 'adaptive' });
  const generic = await manager.prepare({ workspaceProject: 'default', messages: basic().messages });
  assert.equal(generic.contextDecision, 'skipped_irrelevant'); assert.equal(generic.selected.length, 0);
  await assert.rejects(manager.prepare({ workspaceProject: 'default', messages: [{ role: 'user', content: 'analiza el archivo app.js del proyecto' }] }), { code: 'workspace_empty' });
});
test('scan cancellation is observed and the scan slot is reusable', async (t) => {
  const { manager } = await treeFixture(t);
  await assert.rejects(manager.snapshot(undefined, '', { signal: AbortSignal.abort(new Error('cancel')) }), /cancel/);
  assert.equal(manager.scanning, false); assert.ok((await manager.snapshot()).selected.length);
});
test('project registry requires explicit ID and isolates roots without runtime path registration', async (t) => {
  const a = await treeFixture(t), b = await treeFixture(t, { 'other.js': 'SECOND' });
  const file = join(a.dir, 'registry.json');
  await writeFile(file, JSON.stringify({ version: 1, projects: [{ id: 'one', root: a.dir }, { id: 'two', root: b.dir, mode: 'patch' }] }));
  const manager = await WorkspaceManager.fromConfig({ ...config, workspacesFile: file });
  assert.throws(() => manager.select(), { code: 'project_required' });
  assert.throws(() => manager.select('../two'), { code: 'unknown_project' });
  assert.equal(manager.select('two').mode, 'patch');
  assert.ok(!(await manager.snapshot('two')).prompt.includes('src/app.js'));
  assert.ok(!JSON.stringify(manager.list()).includes(b.dir));
});
test('read-only snapshots never create project files or modify file bytes', async (t) => {
  const { dir, manager } = await treeFixture(t); const before = await readFile(join(dir, 'src/app.js'));
  for (let i = 0; i < 3; i++) await manager.snapshot();
  assert.deepEqual(await readFile(join(dir, 'src/app.js')), before);
});

test('embedded double-star is not a globstar that bypasses ignored directories', () => {
  const rules = parseIgnore('dir/sub/file.js\n!dir/**file.js');
  assert.equal(ignored('dir/sub/file.js', false, rules), true);
});
test('directory enumeration has an explicit bound and marks incomplete scans', async (t) => {
  const { manager, project } = await treeFixture(t, { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' });
  project.maxEntries = 2;
  const snap = await manager.snapshot(); assert.equal(snap.summary.scan_truncated, true); assert.ok(snap.selected.length <= 2);
});
test('UTF-8 BOM is preserved as part of the exact file content rather than silently stripped', async (t) => {
  const { manager } = await treeFixture(t, { 'app.js': '\uFEFFconst bom = true;\n' });
  const snap = await manager.snapshot(); assert.equal(snap.selected[0].text[0], '\uFEFF');
});

test('upload metadata questions use inventory only and do not select attachments', async (t) => {
  const { manager } = await treeFixture(t, {
    'README.md': '',
    'src/app.js': 'const value = 1;\n',
    'src/util.js': 'export const util = true;\n',
  }, { contextMode: 'hybrid' });
  const snap = await manager.snapshot(undefined, 'cuantos archivos hay en el workspace');
  assert.equal(snap.metadataOnly, true);
  assert.equal(snap.allowEmpty, true);
  assert.equal(snap.selected.length, 0);
  assert.equal(snap.summary.planned_upload_files, 0);
  assert.equal(snap.summary.planned_upload_messages, 0);
  assert.equal(snap.summary.inventory_files, 3);
  assert.equal(snap.summary.empty_source_files, 1);
  assert.match(snap.prompt, /"eligible_source_files":3/);
  assert.match(snap.prompt, /"metadata_only_request":true/);
  assert.match(snap.prompt, /README\.md/);
});

test('empty source files remain authoritative metadata in upload snapshots', async (t) => {
  const { manager } = await treeFixture(t, { 'README.md': '', 'src/app.js': 'const app = true;\n' }, { contextMode: 'hybrid' });
  const snap = await manager.snapshot(undefined, 'README.md');
  const readme = snap.selected.find((f) => f.path === 'README.md');
  assert.ok(readme);
  const meta = snap.summary.selected_files.find((f) => f.path === 'README.md');
  assert.equal(meta.bytes, 0);
  assert.equal(meta.attachment_name, null);
  assert.equal(meta.attachment_state, 'metadata_only_empty');
  assert.equal(snap.summary.metadata_only_files, 1);
  assert.match(snap.prompt, /metadata_only_empty/);
});

test('adaptive upload does not attach source to unrelated questions', async (t) => {
  const { manager } = await treeFixture(t, { 'src/app.js': 'const app = true;\n', 'README.md': '# Demo\n' }, { contextMode: 'hybrid', contextPolicy: 'adaptive' });
  const snap = await manager.snapshot(undefined, 'en que modelo estas basado');
  assert.equal(snap.contextDecision, 'skipped_irrelevant'); assert.equal(snap.selected.length, 0);
  assert.equal(snap.summary.planned_upload_files, 0); assert.equal(snap.summary.planned_upload_messages, 0);
  assert.equal(snap.summary.source_context_selected, false);
});

test('experimental local actions and source questions both use stable exec capability without uploads', async (t) => {
  const { manager } = await treeFixture(t, { 'src/app.js': 'const app = true;\n', 'README.md': '# Demo\n' }, { contextMode: 'hybrid', contextPolicy: 'adaptive', execMode: 'script' });
  const action = await manager.snapshot(undefined, 'listame los archivos de la ruta actual', { localExec: true });
  assert.equal(action.contextDecision, 'exec_capability'); assert.equal(action.selected.length, 0); assert.equal(action.summary.planned_upload_files, 0);
  const source = await manager.snapshot(undefined, 'explicame la funcion de src/app.js', { localExec: true });
  assert.equal(source.contextDecision, 'exec_capability'); assert.equal(source.selected.length, 0);
  await manager.close();
});

test('EXEC adaptive treats new script/file/folder creation as a local action with zero source uploads', async (t) => {
  const { manager } = await treeFixture(t, { 'existing.sh': '#!/bin/sh\necho old\n', 'README.md': '# Demo\n' }, { contextMode: 'hybrid', contextPolicy: 'adaptive', execMode: 'script' });
  for (const query of [
    'crea un script bash hello world',
    'crea un archivo llamado hello.sh',
    'crea una carpeta output',
    'create a script hello.sh that prints hello world',
    'create a folder named output',
  ]) {
    const snap = await manager.snapshot(undefined, query, { localExec: true });
    assert.equal(snap.contextDecision, 'exec_capability', query);
    assert.equal(snap.selected.length, 0, query);
    assert.equal(snap.summary.planned_upload_files, 0, query);
  }
  await manager.close();
});

test('context-policy always preserves the previous every-turn selection behavior', async (t) => {
  const { manager } = await treeFixture(t, { 'src/app.js': 'const app = true;\n' }, { contextMode: 'hybrid', contextPolicy: 'always' });
  const snap = await manager.snapshot(undefined, 'en que modelo estas basado');
  assert.equal(snap.contextDecision, 'always'); assert.equal(snap.selected.length, 1); assert.equal(snap.summary.planned_upload_files, 1);
});

test('EXEC adaptive treats explicit host command and IP probes as local actions with zero source uploads', async (t) => {
  const { manager } = await treeFixture(t, { 'src/app.js': 'const app = true;\n', 'README.md': '# Demo\n' }, { contextMode: 'hybrid', contextPolicy: 'adaptive', execMode: 'script' });
  for (const query of ['ejecuta tu el comando ip a y dime la ip', 'ejecuta el comando ip a', 'dime la ip de este equipo']) {
    const snap = await manager.snapshot(undefined, query, { localExec: true });
    assert.equal(snap.contextDecision, 'exec_capability', query);
    assert.equal(snap.selected.length, 0, query);
    assert.equal(snap.summary.planned_upload_files, 0, query);
  }
  await manager.close();
});

test('Full Workspace prepare bypasses source scanning and returns only an exec capability manifest', async (t) => {
  const { manager } = await treeFixture(t, { 'src/app.js': 'const app = true;\n' }, { contextMode: 'hybrid', contextPolicy: 'adaptive', execMode: 'script' });
  manager.snapshot = async () => { throw new Error('source scan must not run in Full Workspace request path'); };
  const snap = await manager.prepare({ workspaceProject: 'default', localExec: true, autoWrite: false, messages: [{ role: 'user', content: 'analyze the project' }] });
  assert.equal(snap.contextDecision, 'exec_capability');
  assert.equal(snap.selected.length, 0);
  assert.equal(snap.summary.transport, 'direct_chathub_exec');
  assert.equal(snap.requiresAction, true);
  await manager.close();
});
