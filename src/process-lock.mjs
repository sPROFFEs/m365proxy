// Linux process/profile lock. The kernel guard serializes all launchers and the
// installer; process.lock is diagnostic metadata, not proof of a live owner.
// process.guard intentionally stays on disk: unlinking a flock inode races peers.
import { constants } from 'node:fs';
import { open, readFile, lstat, unlink, link, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { privateDir } from './util.mjs';
import { ProxyError } from './errors.mjs';

const locked = (message) => new ProxyError(409, 'profile_locked', message);
const invalid = (message) => new ProxyError(409, 'profile_lock_invalid', message);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function within(promise, ms) {
  let timer;
  try { await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}

export async function linuxIdentity(pid = process.pid) {
  let stat;
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
  // comm can contain spaces and parentheses. Fields after the LAST ')' start at 3.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw invalid('Cannot verify Linux process identity.');
  return { state: fields[0], start_ticks: fields[19] };
}
async function machineIdentity() {
  return { hostname: hostname(), boot_id: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    pid_namespace: await readlink('/proc/self/ns/pid') };
}
function regular(stat, label) {
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw invalid(`${label} must be a regular single-link file owned by the current user.`);
}
async function snapshot(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw invalid('Refusing a symbolic process lock.');
    throw error;
  }
  try {
    const stat = await handle.stat(); regular(stat, 'process.lock');
    if (stat.size > 8192) throw invalid('process.lock is too large to validate safely.');
    const text = await handle.readFile('utf8');
    let record;
    try { record = JSON.parse(text); } catch { throw invalid('process.lock is malformed; refusing to guess whether its owner is alive. Inspect it manually.'); }
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) throw invalid('process.lock has no valid positive PID. Inspect it manually.');
    return { text, record, stat };
  } finally { await handle.close(); }
}
async function removeSnapshot(path, previous) {
  const current = await snapshot(path);
  if (!current) return;
  if (current.stat.ino !== previous.stat.ino || current.stat.dev !== previous.stat.dev || current.text !== previous.text) throw locked('The state lock changed during validation; no file was removed. Retry after checking the other process.');
  await unlink(path);
}
async function isAlive(record, machine) {
  // Unknown namespaces/hosts can hide a live PID. Refuse rather than steal.
  if (record.hostname && record.hostname !== machine.hostname) throw locked('The state directory belongs to another hostname; automatic recovery is unsafe. Use a local per-user state directory.');
  if (record.boot_id && record.boot_id !== machine.boot_id) return false;
  if (record.pid_namespace && record.pid_namespace !== machine.pid_namespace) throw locked('The recorded PID belongs to a different PID namespace; automatic recovery is unsafe.');
  try { process.kill(record.pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
  let identity;
  try { identity = await linuxIdentity(record.pid); }
  catch { return true; } // Cannot inspect /proc: keep a live/unknown owner safe.
  if (!identity || ['Z', 'X'].includes(identity.state)) return false;
  if (record.start_ticks && record.start_ticks !== identity.start_ticks) return false; // PID reuse.
  return true; // Legacy {pid,created}: a live PID is conservatively protected.
}
async function assertBrowserStopped(dir, machine) {
  let target;
  try { target = await readlink(join(dir, 'browser-profile', 'SingletonLock')); }
  catch (error) { if (['ENOENT', 'EINVAL'].includes(error.code)) return; throw error; }
  const match = target.match(/^(.*)-(\d+)$/);
  if (!match) throw new ProxyError(409, 'browser_profile_busy', 'The dedicated Chromium profile lock cannot be verified. Close its browser before restarting.');
  if (match[1] !== machine.hostname) throw new ProxyError(409, 'browser_profile_busy', 'The dedicated Chromium profile has a lock from another hostname. No Chromium lock was removed.');
  const record = { pid: Number(match[2]) };
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || await isAlive(record, machine)) {
    throw new ProxyError(409, 'browser_profile_busy', 'The dedicated Chromium browser is still running. Close that browser window, then retry. No process was killed and no Chromium lock was removed.');
  }
  // A dead Chromium singleton is left to Chromium itself; never delete it here.
}

async function kernelGuard(dir) {
  const path = join(dir, 'process.guard');
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'ELOOP') throw invalid('Refusing a symbolic process.guard.'); throw error; }
  let child;
  try {
    regular(await handle.stat(), 'process.guard');
    // FD 3 refers to the already checked inode. A separate process group keeps
    // Ctrl+C from releasing the guard before the parent finishes its cleanup.
    // If the parent is SIGKILLed, stdin closes and the holder exits automatically.
    child = spawn('sh', ['-c', 'flock --exclusive --nonblock --conflict-exit-code 73 3 || exit $?; printf "LOCKED\\n"; cat >/dev/null'], {
      detached: true, stdio: ['pipe', 'pipe', 'pipe', handle.fd],
    });
  } finally { await handle.close(); }
  let ended = false, output = '', ready = false, startupError;
  const closed = new Promise((resolve) => {
    child.once('close', (code) => { ended = true; resolve(code); });
    child.once('error', (error) => { startupError = error; });
  });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  child.stdout.on('data', (data) => { output = (output + data.toString()).slice(-100); if (output.includes('LOCKED\n')) ready = true; });
  const release = async () => {
    child.stdin.end();
    await within(closed, 2000);
    if (!ended && child.pid) {
      // This is our own dedicated guard process group, never an inferred PID.
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await within(closed, 1000);
    }
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  };
  // Under a heavily loaded desktop/test runner, spawning the tiny holder can
  // legitimately take more than ten seconds. Give it enough startup time to
  // report flock's precise conflict code instead of misdiagnosing contention as
  // a missing/unavailable lock helper.
  const limit = Date.now() + 20000;
  while (!ready && !ended && !startupError && Date.now() < limit) await pause(5);
  if (!ready) {
    const code = ended ? await closed : null;
    await release();
    if (code === 73) throw locked('Another proxy or installer owns this state directory. Stop it before restarting.');
    throw new ProxyError(503, 'lock_guard_unavailable', 'Cannot acquire the Linux kernel lock. Install util-linux (flock) and check the local state directory.');
  }
  return release;
}

export async function acquireLock(dir, { onRecovery = () => {}, signal } = {}) {
  if (process.platform !== 'linux') throw new ProxyError(503, 'lock_platform_unsupported', 'This hardened lock implementation requires Linux with util-linux/flock.');
  signal?.throwIfAborted();
  await privateDir(dir);
  const releaseGuard = await kernelGuard(dir);
  const path = join(dir, 'process.lock');
  let mine, released = false;
  try {
    signal?.throwIfAborted();
    const machine = await machineIdentity();
    const previous = await snapshot(path);
    if (previous && await isAlive(previous.record, machine)) throw locked(`The recorded owner (PID ${previous.record.pid}) is still alive. No lock was removed.`);
    await assertBrowserStopped(dir, machine);
    if (previous) { await removeSnapshot(path, previous); onRecovery({ pid: previous.record.pid }); }
    const self = await linuxIdentity();
    const record = { schema: 2, pid: process.pid, created: new Date().toISOString(), nonce: randomUUID(), ...machine, start_ticks: self.start_ticks };
    const temporary = join(dir, `.process-lock-${record.nonce}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync();
      // link() publishes an already complete record and NEVER overwrites a peer.
      await link(temporary, path);
    } finally { await handle.close(); await unlink(temporary).catch(() => {}); }
    mine = await snapshot(path);
    signal?.throwIfAborted();
  } catch (error) {
    try { if (mine) await removeSnapshot(path, mine); } finally { await releaseGuard(); }
    throw error;
  }
  return async () => {
    if (released) return;
    released = true;
    try { await removeSnapshot(path, mine); } finally { await releaseGuard(); }
  };
}
