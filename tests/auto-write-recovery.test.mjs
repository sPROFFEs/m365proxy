import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fixture, save, write, reply } from './auto-write-helpers.mjs';
import { basic, fakeCore, fakeAuth, streamOf } from './helpers.mjs';
import { ProxyEngine } from '../src/engine.mjs';
import { readConfig } from '../src/config.mjs';

test('real SIGKILL leaves a recoverable journal and releases the directory kernel lock', async (t) => {
  const f = await fixture(t, { 'a.js': 'a', 'b.js': 'b' });
  const child = fork(fileURLToPath(new URL('fixtures/write-holder.mjs', import.meta.url)), [f.root, f.state], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const signal = AbortSignal.timeout(10000);
  const [message] = await once(child, 'message', { signal }); assert.equal(message, 'first-written');
  child.kill('SIGKILL'); await once(child, 'close', { signal });
  assert.equal(await readFile(join(f.root, 'a.js'), 'utf8'), 'A'); assert.equal(await readFile(join(f.root, 'b.js'), 'utf8'), 'b');
  const records = await f.manager.writer.list(f.project); assert.equal(records[0].status, 'applying');
  await assert.rejects(f.manager.writer.replay(f.project, 'other-request'), { code: 'workspace_recovery_required' });
  // An interrupted write's known temporary name is cleaned without glob deletion.
  const temporary = join(f.root, `.m365-edit-tmp-${records[0].change_id}-0`);
  await writeFile(temporary, 'partial temp bytes');
  await f.manager.writer.undo(f.project, records[0].change_id);
  assert.equal(await readFile(join(f.root, 'a.js'), 'utf8'), 'a');
  assert.equal(await readFile(join(f.root, 'b.js'), 'utf8'), 'b');
  await assert.rejects(stat(temporary), { code: 'ENOENT' });
  assert.equal((await f.manager.writer.list(f.project))[0].status, 'undone');
});
test('failure with a third version reports recovery instead of overwriting local work', async (t) => {
  const f = await fixture(t, { 'a.js': 'a', 'b.js': 'b' });
  await assert.rejects(save(f, [write('a.js', 'A'), write('b.js', 'B')], { beforeCommit: async (i) => {
    if (i === 1) { await writeFile(join(f.root, 'b.js'), 'THIRD'); throw new Error('Interrupted'); }
  } }), { code: 'workspace_recovery_required' });
  assert.equal(await readFile(join(f.root, 'b.js'), 'utf8'), 'THIRD');
  const [record] = await f.manager.writer.list(f.project);
  await writeFile(join(f.root, 'b.js'), 'b'); await f.manager.writer.undo(f.project, record.change_id);
  assert.equal(await readFile(join(f.root, 'a.js'), 'utf8'), 'a');
});
test('an empty registered project can create its first file in automatic read mode', async (t) => {
  const f = await fixture(t, {});
  const engine = new ProxyEngine({ core: fakeCore(), auth: fakeAuth(), config: f.config, workspace: f.manager,
    factory: () => ({ reset() {}, async run(prompt) { return streamOf(reply(prompt, [write('app/main.py', 'print("hello")\n')])); } }) });
  t.after(() => engine.close()); const result = await engine.run(engine.validate(basic()));
  assert.equal(result.x_m365.workspace.write.applied, true);
  assert.equal(await readFile(join(f.root, 'app/main.py'), 'utf8'), 'print("hello")\n');
});
test('new binary/secret content and invalid actions fail before saving', async (t) => {
  const f = await fixture(t);
  for (const contents of ['hello\u0000', '-----BEGIN PRIVATE KEY-----\nsecret', '\ud800']) await assert.rejects(save(f, [write('src/main.js', contents)]), { code: 'edit_contract_error' });
  assert.equal(await readFile(join(f.root, 'src/main.js'), 'utf8'), 'const value = 1;\n');
});
test('write mode defaults off and cannot be enabled without an explicit root', () => {
  assert.equal(readConfig([], {}).writeMode, 'off');
  assert.equal(readConfig([], {}).queueMaxPending, 4);
  assert.throws(() => readConfig(['--write-mode', 'auto'], {}));
  assert.throws(() => readConfig(['--workspace', '/tmp/project', '--context-mode', 'patch', '--write-mode', 'auto'], {}));
  assert.equal(readConfig(['--workspace', '/tmp/project', '--write-mode', 'auto'], {}).writeMode, 'auto');
});
