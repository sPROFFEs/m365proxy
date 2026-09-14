import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, readdir, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configureGuided, runGuidedMenu, saveGuidedProfile, loadGuidedProfile, validateGuidedProfile, terminalIO } from '../src/guided.mjs';
import { saveNamedProfile, loadNamedProfile, listNamedProfiles, deleteNamedProfile, importLegacyProfile } from '../src/profile-store.mjs';
import { readConfig } from '../src/config.mjs';
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'm365-guided-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function ioFixture(answers) {
  const log = []; let closed = false;
  return { log, closed: () => closed, io: { ask: async (q) => { log.push(q); if (!answers.length) throw new Error('Unexpected question: ' + q); return answers.shift(); }, write: (s) => log.push(s), close: () => { closed = true; } } };
}

test('legacy guided profile remains readable for migration and private', async (t) => {
  const dir = await temp(t); const argv = ['--port', '1234', '--state-dir', dir, '--workspace', '/tmp/a b', '--context-mode', 'hybrid'];
  assert.equal(await loadGuidedProfile(dir), null); await saveGuidedProfile(dir, argv);
  assert.deepEqual(await loadGuidedProfile(dir), argv); assert.equal((await stat(join(dir, 'guided.json'))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(dir, 'guided.json'), 'utf8')).includes('api_key'));
});

test('multiple named profiles coexist and never overwrite by default', async (t) => {
  const dir = await temp(t);
  await saveNamedProfile(dir, 'clamav', ['--port', '1234', '--state-dir', dir, '--workspace', '/tmp/clamav', '--context-mode', 'hybrid']);
  await saveNamedProfile(dir, 'other', ['--port', '4321', '--state-dir', dir, '--workspace', '/tmp/other', '--context-mode', 'read']);
  assert.deepEqual((await listNamedProfiles(dir)).map((x) => x.name), ['clamav', 'other']);
  assert.equal(readConfig(await loadNamedProfile(dir, 'clamav'), {}).port, 1234);
  await assert.rejects(saveNamedProfile(dir, 'clamav', ['--port', '9999']), { code: 'profile_exists' });
  assert.equal(readConfig(await loadNamedProfile(dir, 'clamav'), {}).port, 1234);
  await saveNamedProfile(dir, 'clamav', ['--port', '9999', '--state-dir', dir], { overwrite: true });
  assert.equal(readConfig(await loadNamedProfile(dir, 'clamav'), {}).port, 9999);
});

test('legacy single profile imports once as default without deleting the legacy file', async (t) => {
  const dir = await temp(t); await saveGuidedProfile(dir, ['--port', '2222', '--state-dir', dir]);
  assert.equal(await importLegacyProfile(dir), true); assert.equal(await importLegacyProfile(dir), false);
  assert.equal(readConfig(await loadNamedProfile(dir, 'default'), {}).port, 2222);
  assert.ok(await stat(join(dir, 'guided.json')));
});

test('guided rejects arbitrary commands, control characters and invalid argument values', () => {
  for (const argv of [['--execute', 'rm'], ['--port', '0'], ['--channel', 'unknown'], ['--workspace', 'a\nb'], ['--output', '/tmp/secret']]) {
    assert.throws(() => validateGuidedProfile({ version: 1, argv }));
  }
});

test('symlink legacy profile is not read and saving cannot overwrite target', async (t) => {
  const dir = await temp(t), target = join(dir, 'keep'); await writeFile(target, 'KEEP'); await symlink(target, join(dir, 'guided.json'));
  await assert.rejects(loadGuidedProfile(dir)); await saveGuidedProfile(dir, ['--port', '1234']);
  assert.equal(await readFile(target, 'utf8'), 'KEEP'); assert.deepEqual(await loadGuidedProfile(dir), ['--port', '1234']);
});

test('noninteractive menu fails with actionable terminal error', () => {
  assert.throws(() => terminalIO({ isTTY: false }, { isTTY: false }), { code: 'guided_terminal_required' });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'menu'], { encoding: 'utf8', input: '' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /guided_terminal_required/);
});

test('guided standard named profile can be saved without starting any process', async (t) => {
  const dir = await temp(t), base = readConfig(['--state-dir', dir], {});
  // name, port, browser, visible, no-folder mode, conversation reuse, guarded, save, do-not-start
  const f = ioFixture(['simple', '3', '1234', '1', 'n', 's', 'n']);
  const action = await runGuidedMenu(base, { direct: true, io: f.io });
  assert.equal(action, null); assert.equal(f.closed(), true); const cfg = readConfig(await loadNamedProfile(dir, 'simple'), {});
  assert.equal(cfg.port, 1234); assert.equal(cfg.workspaceRoot, undefined); assert.equal(cfg.conversationMode, 'reuse');
});

test('guided upload saves an independent named profile and enables reuse', async (t) => {
  const dir = await temp(t), workspace = join(dir, 'project'); await mkdir(workspace); await writeFile(join(workspace, 'a.js'), 'const x=1;');
  const base = readConfig(['--state-dir', join(dir, 'state')], {});
  // name, port, browser, visible, hybrid, folder, adaptive context,
  // conversation reuse, action=AUTO-WRITE, tool format guarded,
  // max-files, UI-profile, preview-query, consent, save, start
  const f = ioFixture(['work', '4', '1234', '1', 'n', '3', workspace, '1', '1', '2', '1', '5', 'n', 'a.js', 's', 's', 's']);
  const action = await runGuidedMenu(base, { direct: true, io: f.io });
  assert.equal(action.command, 'serve'); assert.equal(action.config.contextMode, 'hybrid'); assert.equal(action.config.uploadMaxFiles, 5);
  assert.equal(action.config.writeMode, 'auto'); assert.equal(action.config.conversationMode, 'reuse');
  assert.ok(f.log.some((s) => s.includes('EXEC SCRIPT [EXP]'))); assert.ok(f.log.some((s) => s.includes('Local action    : AUTO-WRITE')));
  assert.ok(f.log.some((s) => s.includes('a.js'))); assert.ok(f.log.some((s) => s.includes('OneDrive')));
  assert.equal(readConfig(await loadNamedProfile(base.stateDir, 'work'), {}).workspaceRoot, workspace);
  assert.equal(await readFile(join(workspace, 'a.js'), 'utf8'), 'const x=1;');
});

test('declining project consent does not save named configuration or launch service', async (t) => {
  const dir = await temp(t); await writeFile(join(dir, 'a.js'), 'x');
  const state = join(dir, 'state'), base = readConfig(['--state-dir', state], {});
  // adaptive context, reuse, local actions off, guarded tools, preview query, decline consent
  const f = ioFixture(['decline', '4', '', '', 'n', '2', dir, '1', '1', '1', '1', '', 'n']);
  assert.equal(await configureGuided(base, f.io), null); assert.equal(await loadNamedProfile(state, 'decline'), null);
});

test('guided can save experimental script execution separately from automatic writes', async (t) => {
  const dir = await temp(t), workspace = join(dir, 'project'); await mkdir(workspace); await writeFile(join(workspace, 'a.js'), 'const x=1;');
  const base = readConfig(['--state-dir', join(dir, 'state')], {});
  // name, port, browser, visible, read, folder, adaptive, reuse,
  // local action=exec script, max steps, per-step timeout, guarded tools, preview query, consent, save, do not start
  const f = ioFixture(['exec-lab', '1', '1234', '1', 'n', workspace, 's', 'n']);
  const action = await runGuidedMenu(base, { direct: true, io: f.io });
  assert.equal(action, null);
  const cfg = readConfig(await loadNamedProfile(base.stateDir, 'exec-lab'), {});
  assert.equal(cfg.writeMode, 'off'); assert.equal(cfg.execMode, 'script'); assert.equal(cfg.execMaxSteps, 6); assert.equal(cfg.execTimeoutMs, 30000); assert.equal(cfg.contextMode, 'read');
});


test('guided always exposes exec as an explicit alternative even when editing an auto-write profile', async (t) => {
  const dir = await temp(t), workspace = join(dir, 'project'); await mkdir(workspace); await writeFile(join(workspace, 'a.js'), 'const x=1;');
  const state = join(dir, 'state');
  const base = readConfig(['--state-dir', state, '--workspace', workspace, '--context-mode', 'read', '--write-mode', 'auto', '--exec-mode', 'off'], {});
  // existing profile edit: port, browser, visible, read, folder, adaptive, reuse,
  // choose EXEC explicitly (default would be AUTO-WRITE), max steps, timeout, guarded tools,
  // preview query, consent, save, do not start
  const f = ioFixture(['4', '1234', '1', 'n', '2', workspace, '1', '1', '3', '2', '10000', '1', 'a.js', 's', 's', 'n']);
  await saveNamedProfile(state, 'editable', ['--state-dir', state, '--workspace', workspace, '--context-mode', 'read', '--write-mode', 'auto', '--exec-mode', 'off']);
  const action = await configureGuided(base, f.io, { profileName: 'editable', overwrite: true, askProfileName: false });
  assert.equal(action, null);
  const cfg = readConfig(await loadNamedProfile(state, 'editable'), {});
  assert.equal(cfg.writeMode, 'off'); assert.equal(cfg.execMode, 'script');
  assert.ok(f.log.some((s) => s.includes('Local action mode')));
  assert.ok(f.log.some((s) => s.includes('EXEC SCRIPT EXPERIMENTAL ACTIVATED')));
  assert.ok(f.log.some((s) => s.includes('Local action    : EXEC SCRIPT [EXPERIMENTAL]')));
});

test('menu exit creates no named profile, key or browser', async (t) => {
  const dir = await temp(t), f = ioFixture(['0']);
  assert.equal(await runGuidedMenu(readConfig(['--state-dir', dir], {}), { io: f.io }), null);
  assert.deepEqual(await readdir(dir), []); assert.equal(f.closed(), true);
});

test('menu can start a selected saved profile without parsing paths as shell', async (t) => {
  const dir = await temp(t), root = '/tmp/project; touch /tmp/NO_EXECUTION';
  await saveNamedProfile(dir, 'dangerous-name-is-data', ['--port', '1234', '--state-dir', dir, '--workspace', root]);
  const f = ioFixture(['2', '1', 's']); const action = await runGuidedMenu(readConfig(['--state-dir', dir], {}), { io: f.io });
  assert.equal(action.config.workspaceRoot, root); assert.equal(action.command, 'serve'); assert.equal(action.profileName, 'dangerous-name-is-data');
});

test('menu status uses chosen profile and probe still requires confirmation', async (t) => {
  const dir = await temp(t); await saveNamedProfile(dir, 'p', ['--port', '1234', '--state-dir', dir]);
  const f = ioFixture(['5', '1', '', '6', '1', '', 'n', '0']), calls = [];
  await runGuidedMenu(readConfig(['--state-dir', dir], {}), { io: f.io, diagnoseFn: async (...args) => calls.push(args) });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'status'); assert.equal(calls[0][1].port, 1234);
});

test('menu lists backups and undo uses selected profile without another change confirmation', async (t) => {
  const dir = await temp(t); await saveNamedProfile(dir, 'p', ['--port', '1234', '--state-dir', dir]);
  const id = 'f0000000-0000-0000-0000-000000000001';
  const f = ioFixture(['10', '1', '', '11', '1', '', id, '0']), calls = [];
  await runGuidedMenu(readConfig(['--state-dir', dir], {}), { io: f.io, changeFn: async (cmd, cfg) => calls.push({ cmd, cfg }) });
  assert.deepEqual(calls.map((c) => c.cmd), ['changes', 'undo']); assert.equal(calls[1].cfg.port, 1234); assert.equal(calls[1].cfg.changeId, id);
});

test('menu deletes only the selected named profile', async (t) => {
  const dir = await temp(t); await saveNamedProfile(dir, 'one', ['--port', '1111', '--state-dir', dir]); await saveNamedProfile(dir, 'two', ['--port', '2222', '--state-dir', dir]);
  const f = ioFixture(['12', '1', 's', '0']); await runGuidedMenu(readConfig(['--state-dir', dir], {}), { io: f.io });
  assert.equal(await loadNamedProfile(dir, 'one'), null); assert.ok(await loadNamedProfile(dir, 'two')); assert.equal(await deleteNamedProfile(dir, 'missing'), false);
});
