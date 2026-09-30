// Cross-platform process/profile lock.
//
// Linux keeps the hardened flock + /proc identity implementation. macOS and
// Windows use an atomic O_EXCL lock file plus hard-link claims for safe stale
// lock recovery. process.lock is diagnostic metadata and never authorizes
// killing another process.
import { constants } from 'node:fs';
import { open, readFile, lstat, unlink, link, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

// ---------------------------------------------------------------------------
// Linux hardened lock
// ---------------------------------------------------------------------------

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

async function acquireLinuxLock(dir, { onRecovery = () => {}, signal } = {}) {
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

// ---------------------------------------------------------------------------
// macOS / Windows portable lock
// ---------------------------------------------------------------------------

function sameIdentity(a, b) {
  // Node exposes stable dev/ino values on normal APFS/HFS+/NTFS filesystems.
  // Fall back to immutable snapshot metadata if a platform reports zero inodes.
  if (a.dev !== 0 && a.ino !== 0 && b.dev !== 0 && b.ino !== 0) return a.dev === b.dev && a.ino === b.ino;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.birthtimeMs === b.birthtimeMs;
}

async function portableSnapshot(path) {
  let before;
  try { before = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (before.isSymbolicLink() || !before.isFile()) throw invalid('process.lock must be a regular file, not a symlink or directory.');
  if (before.size > 8192) throw invalid('process.lock is too large to validate safely.');
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!sameIdentity(before, stat)) throw locked('The state lock changed while it was being inspected. Retry.');
    const text = await handle.readFile('utf8');
    let record;
    try { record = JSON.parse(text); } catch { throw invalid('process.lock is malformed; inspect it manually before retrying.'); }
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) throw invalid('process.lock has no valid positive PID. Inspect it manually.');
    return { text, record, stat };
  } finally { await handle.close(); }
}

async function portableAlive(record) {
  if (record.hostname && record.hostname !== hostname()) {
    throw locked('The state directory belongs to another hostname; automatic recovery is unsafe. Use a local per-user state directory.');
  }
  if (record.platform && record.platform !== process.platform) {
    throw locked(`The state directory was locked on ${record.platform}; automatic cross-platform recovery is unsafe.`);
  }
  try { process.kill(record.pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    // Windows can report EINVAL for an invalid/dead PID depending on the host.
    if (process.platform === 'win32' && error.code === 'EINVAL') return false;
    throw error;
  }
  return true;
}

async function removePortableSnapshot(path, previous) {
  // Claim the exact inode with a hard link before unlinking the well-known name.
  // If another process replaces process.lock between validation and cleanup, the
  // inode comparison below prevents us from deleting the replacement.
  const claim = join(dirname(path), `.process-lock-claim-${randomUUID()}.tmp`);
  try {
    try { await link(path, claim); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        throw new ProxyError(503, 'lock_guard_unavailable', 'The state directory filesystem must support local hard links for safe stale-lock recovery.');
      }
      throw error;
    }
    const claimed = await portableSnapshot(claim);
    if (!claimed || !sameIdentity(claimed.stat, previous.stat) || claimed.text !== previous.text) {
      throw locked('The state lock changed during recovery; no lock was removed. Retry.');
    }
    const current = await portableSnapshot(path);
    if (!current) return;
    if (!sameIdentity(current.stat, claimed.stat) || current.text !== previous.text) {
      throw locked('The state lock changed during recovery; no lock was removed. Retry.');
    }
    await unlink(path);
  } finally { await unlink(claim).catch(() => {}); }
}

async function acquirePortableLock(dir, { onRecovery = () => {}, signal } = {}) {
  signal?.throwIfAborted();
  await privateDir(dir);
  const path = join(dir, 'process.lock');
  let mine;

  for (let attempt = 0; attempt < 4 && !mine; attempt++) {
    signal?.throwIfAborted();
    const record = {
      schema: 3,
      pid: process.pid,
      created: new Date().toISOString(),
      nonce: randomUUID(),
      hostname: hostname(),
      platform: process.platform,
    };
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record) + '\n');
      await handle.sync();
      await handle.close();
      handle = null;
      mine = await portableSnapshot(path);
      if (!mine || mine.record.nonce !== record.nonce) throw locked('The state lock changed immediately after creation. Retry.');
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      const previous = await portableSnapshot(path);
      if (!previous) continue;
      if (await portableAlive(previous.record)) throw locked(`The recorded owner (PID ${previous.record.pid}) is still alive. No lock was removed.`);
      await removePortableSnapshot(path, previous);
      onRecovery({ pid: previous.record.pid });
    }
  }

  if (!mine) throw locked('Could not acquire the state lock after recovering a stale owner. Retry.');
  try { signal?.throwIfAborted(); }
  catch (error) { await removePortableSnapshot(path, mine); throw error; }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await removePortableSnapshot(path, mine);
  };
}

export async function acquireLock(dir, options = {}) {
  if (process.platform === 'linux') return acquireLinuxLock(dir, options);
  if (process.platform === 'darwin' || process.platform === 'win32') return acquirePortableLock(dir, options);
  throw new ProxyError(503, 'lock_platform_unsupported', `Unsupported lock platform: ${process.platform}.`);
}
