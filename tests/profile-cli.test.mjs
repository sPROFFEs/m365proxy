import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { profileAction } from '../src/profile-cli.mjs';
import { saveNamedProfile, loadNamedProfile } from '../src/profile-store.mjs';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'm365-profile-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function output() { const lines = []; return { lines, log: (s) => lines.push(String(s)) }; }

test('profile list/show/run keep independent workspaces and runtime settings', async (t) => {
  const state = await temp(t);
  await saveNamedProfile(state, 'alpha', ['--state-dir', state, '--port', '1234', '--workspace', '/tmp/alpha', '--context-mode', 'hybrid', '--conversation-mode', 'reuse']);
  await saveNamedProfile(state, 'beta', ['--state-dir', state, '--port', '4321', '--workspace', '/tmp/beta', '--context-mode', 'read', '--conversation-mode', 'fresh']);

  const out = output();
  assert.deepEqual(await profileAction(['list', '--state-dir', state], out), { done: true });
  const listed = JSON.parse(out.lines.at(-1));
  assert.deepEqual(listed.profiles.map((p) => p.name), ['alpha', 'beta']);
  assert.equal(listed.profiles[0].workspace, '/tmp/alpha');
  assert.equal(listed.profiles[1].workspace, '/tmp/beta');

  const runA = await profileAction(['run', 'alpha', '--state-dir', state], out);
  const runB = await profileAction(['run', 'beta', '--state-dir', state], out);
  assert.equal(runA.done, false); assert.equal(runA.config.port, 1234); assert.equal(runA.config.workspaceRoot, '/tmp/alpha'); assert.equal(runA.config.conversationMode, 'reuse');
  assert.equal(runB.done, false); assert.equal(runB.config.port, 4321); assert.equal(runB.config.workspaceRoot, '/tmp/beta'); assert.equal(runB.config.conversationMode, 'fresh');
});

test('profile clone never overwrites and delete affects only the chosen config', async (t) => {
  const state = await temp(t), out = output();
  await saveNamedProfile(state, 'base', ['--state-dir', state, '--port', '1234']);
  await profileAction(['clone', 'base', 'copy', '--state-dir', state], out);
  assert.deepEqual(await loadNamedProfile(state, 'copy'), await loadNamedProfile(state, 'base'));
  await assert.rejects(profileAction(['clone', 'base', 'copy', '--state-dir', state], out), { code: 'profile_exists' });
  await profileAction(['delete', 'copy', '--state-dir', state], out);
  assert.equal(await loadNamedProfile(state, 'copy'), null);
  assert.ok(await loadNamedProfile(state, 'base'));
});

test('profile commands reject silent runtime overrides', async (t) => {
  const state = await temp(t), out = output();
  await saveNamedProfile(state, 'base', ['--state-dir', state, '--port', '1234']);
  await assert.rejects(profileAction(['run', 'base', '--port', '9999'], out), { code: 'invalid_request' });
});
