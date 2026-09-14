// No Microsoft access. These tests use real Linux /proc, flock, child processes,
// SIGINT, SIGTERM, SIGHUP and SIGKILL, not a mocked PID table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, linuxIdentity } from '../src/process-lock.mjs';
const linux = process.platform === 'linux';
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'm365-lock-032-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
function child(t, file, args) {
  const proc = spawn(process.execPath, [fixture(file), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = ''; let closed = false;
  proc.stdout.on('data', (s) => { out += s; }); proc.stderr.on('data', (s) => { err += s; });
  const finished = new Promise((resolve) => proc.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  t.after(async () => { if (!closed) proc.kill('SIGKILL'); await finished; });
  return { proc, finished, out: () => out, err: () => err,
    async ready(marker = 'READY') {
      for (let i = 0; i < 600 && !closed; i++) { if (out.includes(marker)) return; await pause(5); }
      throw new Error(`Child did not start: ${out} ${err}`);
    } };
}
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`service cleans PID metadata and releases kernel guard on ${signal}`, { skip: !linux }, async (t) => {
    const state = await dir(t); const p = child(t, 'service-process', [state]);
    await p.ready('FIXTURE_STARTED'); p.proc.kill(signal);
    const result = await p.finished;
    assert.equal(result.code, { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
    await absent(join(state, 'process.lock'));
    assert.equal(await readFile(join(state, 'browser-close-was-called'), 'utf8'), 'yes');
    const release = await acquireLock(state); await release();
  });
}
for (const mode of ['starting', 'hanging-close', 'throwing-close']) {
  test(`Ctrl+C still releases the lock when browser is ${mode}`, { skip: !linux }, async (t) => {
    const state = await dir(t); const p = child(t, 'service-process', [state, mode]);
    await p.ready('FIXTURE_STARTED'); const start = Date.now(); p.proc.kill('SIGINT');
    assert.equal((await p.finished).code, 130); assert.ok(Date.now() - start < 3500);
    await absent(join(state, 'process.lock')); const release = await acquireLock(state); await release();
  });
}
test('SIGKILL leaves metadata but the next process recovers it automatically', { skip: !linux }, async (t) => {
  const state = await dir(t); const p = child(t, 'lock-holder', [state]);
  await p.ready(); const pid = p.proc.pid; p.proc.kill('SIGKILL'); await p.finished;
  assert.equal(JSON.parse(await readFile(join(state, 'process.lock'), 'utf8')).pid, pid);
  await pause(30); const recovered = [];
  const release = await acquireLock(state, { onRecovery: (event) => recovered.push(event) });
  assert.deepEqual(recovered, [{ pid }]); await release(); await absent(join(state, 'process.lock'));
});
test('two different state directories are not accidentally serialized by a cwd lock file', { skip: !linux }, async (t) => {
  const a = await dir(t), b = await dir(t); const releaseA = await acquireLock(a);
  const releaseB = await acquireLock(b); await releaseB(); await releaseA();
});
test('a live owner with a kernel guard cannot be displaced', { skip: !linux }, async (t) => {
  const state = await dir(t); const p = child(t, 'lock-holder', [state]); await p.ready();
  const before = await readFile(join(state, 'process.lock'), 'utf8');
  await assert.rejects(acquireLock(state), { code: 'profile_locked' });
  assert.equal(await readFile(join(state, 'process.lock'), 'utf8'), before);
  p.proc.stdin.end(); assert.equal((await p.finished).code, 0);
});
test('legacy live PID is preserved, even without a kernel guard', { skip: !linux }, async (t) => {
  const state = await dir(t); const text = JSON.stringify({ pid: process.pid, created: 'old-format' });
  await writeFile(join(state, 'process.lock'), text);
  await assert.rejects(acquireLock(state), { code: 'profile_locked' });
  assert.equal(await readFile(join(state, 'process.lock'), 'utf8'), text);
});
test('legacy dead PID metadata is recovered on start', { skip: !linux }, async (t) => {
  const state = await dir(t); await writeFile(join(state, 'process.lock'), JSON.stringify({ pid: 2147483647 }));
  let recovered = false; const release = await acquireLock(state, { onRecovery: () => { recovered = true; } });
  assert.equal(recovered, true); await release();
});
test('PID reuse is recognized by Linux start ticks, not only kill(pid, 0)', { skip: !linux }, async (t) => {
  const state = await dir(t); const self = await linuxIdentity();
  await writeFile(join(state, 'process.lock'), JSON.stringify({ pid: process.pid, start_ticks: (BigInt(self.start_ticks) + 1n).toString() }));
  const release = await acquireLock(state); await release();
});
test('an old Linux boot identity makes otherwise matching PID metadata stale', { skip: !linux }, async (t) => {
  const state = await dir(t); await writeFile(join(state, 'process.lock'), JSON.stringify({ pid: process.pid, boot_id: 'previous-boot' }));
  const release = await acquireLock(state); await release();
});
test('different host or PID namespace is conservatively refused', { skip: !linux }, async (t) => {
  const state = await dir(t);
  for (const extra of [{ hostname: 'different-host.invalid' }, { pid_namespace: 'pid:[other]' }]) {
    await writeFile(join(state, 'process.lock'), JSON.stringify({ pid: process.pid, ...extra }));
    await assert.rejects(acquireLock(state), { code: 'profile_locked' });
  }
});
test('a live dedicated Chromium singleton is not stolen after proxy death', { skip: !linux }, async (t) => {
  const state = await dir(t); await mkdir(join(state, 'browser-profile'));
  await symlink(`${hostname()}-${process.pid}`, join(state, 'browser-profile/SingletonLock'));
  await assert.rejects(acquireLock(state), { code: 'browser_profile_busy' });
  assert.ok((await lstat(join(state, 'browser-profile/SingletonLock'))).isSymbolicLink());
});
test('dead Chromium singleton remains for Chromium itself, not removed by proxy', { skip: !linux }, async (t) => {
  const state = await dir(t); await mkdir(join(state, 'browser-profile'));
  await symlink(`${hostname()}-2147483647`, join(state, 'browser-profile/SingletonLock'));
  const release = await acquireLock(state); await release();
  assert.ok((await lstat(join(state, 'browser-profile/SingletonLock'))).isSymbolicLink());
});
test('malformed and symbolic lock files are never blindly deleted', { skip: !linux }, async (t) => {
  const state = await dir(t); const path = join(state, 'process.lock');
  await writeFile(path, 'corrupted'); await assert.rejects(acquireLock(state), { code: 'profile_lock_invalid' });
  assert.equal(await readFile(path, 'utf8'), 'corrupted'); await rm(path);
  await writeFile(join(state, 'other'), JSON.stringify({ pid: 2147483647 })); await symlink(join(state, 'other'), path);
  await assert.rejects(acquireLock(state), { code: 'profile_lock_invalid' });
  assert.ok((await lstat(path)).isSymbolicLink());
});
test('symbolic kernel guard is refused without touching its target', { skip: !linux }, async (t) => {
  const state = await dir(t); await writeFile(join(state, 'other'), 'KEEP');
  await symlink(join(state, 'other'), join(state, 'process.guard'));
  await assert.rejects(acquireLock(state), { code: 'profile_lock_invalid' });
  assert.equal(await readFile(join(state, 'other'), 'utf8'), 'KEEP');
});
test('old release callback does not delete another owner\'s changed record', { skip: !linux }, async (t) => {
  const state = await dir(t); const release = await acquireLock(state);
  const path = join(state, 'process.lock'); const changed = JSON.stringify({ pid: process.pid, nonce: 'different' });
  await writeFile(path, changed); await assert.rejects(release(), { code: 'profile_locked' });
  assert.equal(await readFile(path, 'utf8'), changed);
});
test('competing starts after a stale lock admit only one process', { skip: !linux }, async (t) => {
  const state = await dir(t); await writeFile(join(state, 'process.lock'), JSON.stringify({ pid: 2147483647 }));
  const a = child(t, 'lock-holder', [state]), b = child(t, 'lock-holder', [state]);
  for (let i = 0; i < 600 && !a.out().includes('READY') && !b.out().includes('READY'); i++) await pause(5);
  assert.ok(a.out().includes('READY') || b.out().includes('READY')); await pause(100);
  const winner = a.out().includes('READY') ? a : b; const loser = winner === a ? b : a;
  assert.equal((await loser.finished).code, 1); assert.match(loser.err(), /profile_locked/);
  winner.proc.stdin.end(); assert.equal((await winner.finished).code, 0);
});
