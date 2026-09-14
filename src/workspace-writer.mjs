// Automatic, bounded source writes. No model-supplied commands are executed.
// Linux directory FDs anchor resolution; flock serializes cooperating writers
// even with different proxy state directories. Not a sandbox against same-UID
// processes racing filesystem operations. Multi-file writes are NOT one atomic
// filesystem transaction: a durable journal supports guarded rollback/recovery.
import { open, mkdir, rename, unlink, link, readdir, realpath, rm, lstat, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { ProxyError } from './errors.mjs';
import { sha256, stable, safeEqual, privateDir } from './util.mjs';
import { sourcePath, validRelative, textBytes } from './workspace-files.mjs';

const LIMIT = 1048576;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const failure = (code, message, status = 409) => new ProxyError(status, code, message);
const hash = (file) => file?.sha256 ?? null;
const terminal = new Set(['applied', 'undone', 'rolled_back']);

async function lockDirectory(fd, signal) {
  signal?.throwIfAborted();
  // flock locks the shared open file description inherited as FD 3. The parent
  // keeps that description open until withRoot finishes (including rollback).
  const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const abort = () => { child.kill('SIGKILL'); finish(signal.reason); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(failure('write_lock_unavailable', 'Timed out acquiring the workspace write lock.', 503)); }, 3000);
    child.once('error', () => finish(failure('write_lock_unavailable', 'Automatic writes require Linux util-linux/flock.', 503)));
    child.once('close', (code) => finish(code === 0 ? null : failure(code === 73 ? 'workspace_write_busy' : 'write_lock_unavailable', 'Cannot acquire the workspace write lock; no change was started.')));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
async function secureRead(path, limit) {
  let fd;
  try { fd = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (e) { if (e.code === 'ENOENT') return null; throw failure('write_path_unsafe', 'A target or journal path is not a safe regular file.'); }
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) throw failure('write_path_unsafe', 'A target or backup is a special file, hard link, or exceeds the size limit.');
    const bytes = Buffer.alloc(Number(before.size) + 1); let size = 0;
    while (size < bytes.length) { const part = await fd.read(bytes, size, bytes.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
    const after = await fd.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || size !== Number(before.size)) throw failure('write_base_changed', 'A file changed while checking its current version.');
    const data = bytes.subarray(0, size), text = textBytes(data);
    if (text === null) throw failure('write_path_unsafe', 'Only UTF-8 source text can be edited or restored.');
    return { text, sha256: sha256(data), mode: Number(before.mode & 0o777n), identity: `${before.dev}:${before.ino}` };
  } finally { await fd.close(); }
}
async function syncDir(path) { const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); } }
async function durableFile(path, text, mode = 0o600) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await fd.writeFile(text, 'utf8'); await fd.chmod(mode); await fd.sync(); } finally { await fd.close(); }
}
async function withParent(tree, root, path, create, action, { directoryTarget = false } = {}) {
  const policyPath = directoryTarget ? validRelative(path) : sourcePath(path);
  if (!tree.allowed(path) || !policyPath) throw failure('write_path_denied', 'The change is outside the configured source policy.');
  const parts = path.split('/'), handles = []; let dir = root;
  try {
    for (const part of parts.slice(0, -1)) {
      const child = `/proc/self/fd/${dir.fd}/${part}`;
      if (create) { try { await mkdir(child, { mode: 0o755 }); await dir.sync(); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
      const next = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(next); dir = next;
    }
    const canonical = await realpath(`/proc/self/fd/${dir.fd}`);
    if (canonical !== tree.root && !canonical.startsWith(tree.root + '/')) throw failure('write_path_denied', 'A parent directory moved outside the workspace.');
    return await action(`/proc/self/fd/${dir.fd}/${parts.at(-1)}`, dir);
  } finally { for (const fd of handles.reverse()) await fd.close(); }
}
async function currentFile(tree, root, path) {
  try { return await withParent(tree, root, path, false, (p) => secureRead(p, LIMIT)); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function currentDirectory(tree, root, path) {
  try {
    return await withParent(tree, root, path, false, async (target) => {
      let stat;
      try { stat = await lstat(target, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('write_path_unsafe', 'A directory target is a symlink, file or special path.');
      return { identity: `${stat.dev}:${stat.ino}`, mode: Number(stat.mode & 0o777n) };
    }, { directoryTarget: true });
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function createDirectory(tree, root, path, mode = 0o755) {
  return withParent(tree, root, path, false, async (target, parent) => {
    let existing;
    try { existing = await lstat(target, { bigint: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing) throw failure('write_base_changed', 'A proposed new directory already exists. Nothing was written.');
    await mkdir(target, { mode });
    const stat = await lstat(target, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('write_path_unsafe', 'The created directory path was replaced unexpectedly.');
    await parent.sync();
    return { identity: `${stat.dev}:${stat.ino}`, mode: Number(stat.mode & 0o777n) };
  }, { directoryTarget: true });
}
async function removeDirectory(tree, root, path, expectedIdentity) {
  return withParent(tree, root, path, false, async (target, parent) => {
    let stat;
    try { stat = await lstat(target, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== expectedIdentity)
      throw failure('undo_conflict', 'A created directory changed identity. It was not removed by rollback/undo.');
    try { await rmdir(target); }
    catch (e) { if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw failure('undo_conflict', 'A created directory is no longer empty. It was not removed by rollback/undo.'); throw e; }
    await parent.sync();
  }, { directoryTarget: true });
}
async function replaceFile(tree, root, path, expectedHash, text, mode, temporaryName) {
  return withParent(tree, root, path, text !== null, async (target, parent) => {
    let tmp;
    try {
      if (text !== null && Buffer.byteLength(text) > LIMIT) throw failure('write_size_limit', 'The replacement exceeds the local edit limit.', 422);
      if (text !== null) { tmp = `/proc/self/fd/${parent.fd}/${temporaryName ?? '.m365-edit-tmp-' + randomUUID()}`; await durableFile(tmp, text, mode); }
      const current = await secureRead(target, LIMIT);
      if (hash(current) !== expectedHash) throw failure('write_base_changed', 'A target changed just before saving. No conflicting content was overwritten.');
      const canonical = await realpath(`/proc/self/fd/${parent.fd}`);
      if (canonical !== tree.root && !canonical.startsWith(tree.root + '/')) throw failure('write_path_denied', 'A parent directory moved while preparing a write.');
      if (text === null) { if (current) await unlink(target); }
      else if (expectedHash === null) { await link(tmp, target); await unlink(tmp); tmp = undefined; }
      else { await rename(tmp, target); tmp = undefined; }
      await parent.sync();
    } finally { if (tmp) await unlink(tmp).catch(() => {}); }
  });
}

export class WorkspaceWriter {
  constructor(stateDir, key) { this.stateDir = stateDir; this.key = key; }
  location(project) {
    if (!this.stateDir) throw failure('write_state_required', 'Automatic writes require a private --state-dir.', 400);
    return join(this.stateDir, 'changes', project.fingerprint);
  }
  signature(record) { const { signature, ...fields } = record; return createHmac('sha256', this.key).update('m365proxy.journal.v1\n' + stable(fields)).digest('hex'); }
  async save(dir, record) {
    const tmp = join(dir, '.record-' + randomUUID() + '.tmp');
    try { await durableFile(tmp, JSON.stringify({ ...record, signature: this.signature(record) }, null, 2) + '\n'); await rename(tmp, join(dir, 'record.json')); await syncDir(dir); }
    finally { await unlink(tmp).catch(() => {}); }
  }
  async read(project, id) {
    if (!ID.test(id ?? '')) throw failure('change_id_invalid', 'Use a change ID returned by m365proxy changes.', 400);
    const dir = join(this.location(project), id);
    // realpath verification prevents reading a user-replaced journal symlink.
    const resolved = await realpath(dir).catch(() => null);
    if (resolved !== dir) throw failure('change_not_found', 'The change journal is absent or unsafe.', 404);
    const raw = await secureRead(join(dir, 'record.json'), LIMIT);
    let record;
    try { record = JSON.parse(raw?.text); } catch { throw failure('journal_corrupt', 'A change journal is incomplete or corrupt. Inspect the private backup directory.'); }
    if (record.format !== 'm365proxy.journal.v1' || record.id !== id || record.root_fingerprint !== project.fingerprint ||
        !safeEqual(record.signature, this.signature(record)) || !Array.isArray(record.files) || record.files.length > 16)
      throw failure('journal_corrupt', 'Change journal identity or signature is invalid.');
    return { dir, record };
  }
  async records(project) {
    const base = this.location(project);
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    if (entries.length > 2000) throw failure('journal_capacity', 'More than 2000 change journals exist; archive old records before continuing.');
    const out = [];
    for (const entry of entries) if (ID.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure('journal_corrupt', 'A change entry is not a regular directory.');
      out.push(await this.read(project, entry.name));
    }
    return out.sort((a, b) => b.record.created_at.localeCompare(a.record.created_at));
  }
  receipt(record, replayed = false) {
    return { applied: true, replayed, change_id: record.id, project_id: record.project_id, snapshot_id: record.snapshot_id,
      backup_saved: true, executed_commands: false,
      files: record.files.map((f) => f.kind === 'directory'
        ? { path: f.path, action: 'created_directory', kind: 'directory' }
        : { path: f.path, action: f.before_sha256 === null ? 'created' : f.after_sha256 === null ? 'deleted' : 'updated',
          kind: 'file', before_sha256: f.before_sha256, after_sha256: f.after_sha256 }) };
  }
  async replay(project, requestFingerprint, { signal, idempotencyKeyHash } = {}) {
    const items = await this.records(project);
    const pending = items.find(({ record }) => !terminal.has(record.status));
    if (pending) throw failure('workspace_recovery_required', `An interrupted change needs recovery: ${pending.record.id}. Run m365proxy undo --change-id ${pending.record.id} against this server.`);
    if (idempotencyKeyHash && items.some(({ record }) => record.idempotency_key_hash === idempotencyKeyHash && record.request_fingerprint !== requestFingerprint)) throw failure('idempotency_conflict', 'This Idempotency-Key was already used for a different request.');
    const match = items.find(({ record }) => record.request_fingerprint === requestFingerprint);
    if (!match) return null;
    if (match.record.status !== 'applied') throw failure('write_replay_conflict', 'This request was previously rolled back or undone. Send a new instruction or a new Idempotency-Key.');
    for (const file of match.record.files) {
      signal?.throwIfAborted();
      if (file.kind === 'directory') {
        const current = await project.tree.withRoot((root) => currentDirectory(project.tree, root, file.path));
        if (!current || current.identity !== file.after_identity) throw failure('write_replay_conflict', 'A previously created directory changed or disappeared. Send a new instruction; the old change was not repeated.');
      } else {
        const current = await project.tree.withRoot((root) => currentFile(project.tree, root, file.path));
        if (hash(current) !== file.after_sha256) throw failure('write_replay_conflict', 'A previously applied request was retried after local changes. Send a new instruction; the old write was not repeated.');
      }
    }
    return this.receipt(match.record, true);
  }
  async list(project) {
    return (await this.records(project)).map(({ record }) => ({ change_id: record.id, created_at: record.created_at, status: record.status,
      project_id: record.project_id, files: record.files.map((f) => f.kind === 'directory'
        ? { path: f.path, kind: 'directory', action: 'created_directory' }
        : { path: f.path, kind: 'file', before_sha256: f.before_sha256, after_sha256: f.after_sha256 }) }));
  }
  async apply(project, snapshot, changes, { requestFingerprint, idempotencyKeyHash, signal, beforeCommit } = {}) {
    if (!changes.length) return { applied: false, executed_commands: false, files: [] };
    signal?.throwIfAborted();
    return project.tree.withRoot(async (root) => {
      await lockDirectory(root.fd, signal);
      const replay = await this.replay(project, requestFingerprint, { signal, idempotencyKeyHash });
      if (replay) return replay;
      // Preflight ALL paths before creating any transaction or modifying source.
      const files = [];
      for (const change of changes) {
        signal?.throwIfAborted();
        if (changes.length > 16) throw failure('edit_contract_error', 'Invalid local write plan.', 422);
        if (change.kind === 'directory') {
          if (change.operation !== 'mkdir' || !validRelative(change.path) || !project.tree.allowed(change.path) || project.pathIgnored(change.path, snapshot.rules, true))
            throw failure('write_policy_changed', 'A directory target is excluded by the current project policy.');
          const current = await currentDirectory(project.tree, root, change.path);
          if (current) throw failure('write_base_changed', 'A proposed new directory already exists. Nothing was written.');
          files.push({ kind: 'directory', operation: 'mkdir', path: change.path, before_identity: null, after_identity: null, mode: 0o755 });
          continue;
        }
        if ((change.before === null ? null : sha256(change.before)) !== change.before_sha256 || (change.after === null ? null : sha256(change.after)) !== change.after_sha256)
          throw failure('edit_contract_error', 'Invalid local write plan.', 422);
        if (!project.tree.allowed(change.path) || project.pathIgnored(change.path, snapshot.rules)) throw failure('write_policy_changed', 'A target is excluded by the current project policy.');
        const current = await currentFile(project.tree, root, change.path);
        if (hash(current) !== change.before_sha256) throw failure('write_base_changed', 'An edit target changed or a proposed new file already exists. Nothing was written.');
        files.push({ kind: 'file', path: change.path, before_sha256: change.before_sha256, after_sha256: change.after_sha256,
          mode: current?.mode ?? 0o644 });
      }
      await privateDir(this.stateDir); await privateDir(join(this.stateDir, 'changes')); await privateDir(this.location(project));
      const record = { format: 'm365proxy.journal.v1', id: randomUUID(), project_id: project.id, root_fingerprint: project.fingerprint,
        snapshot_id: snapshot.id, request_fingerprint: requestFingerprint ?? null, idempotency_key_hash: idempotencyKeyHash ?? null, created_at: new Date().toISOString(), status: 'prepared', files };
      const targetDir = join(this.location(project), record.id);
      let dir = join(this.location(project), '.pending-' + record.id), published = false;
      await mkdir(dir, { mode: 0o700 });
      try {
        // Every original is durable before the first file change. If backup
        // preparation fails, no source write has occurred.
        for (const [i, change] of changes.entries()) if (change.kind !== 'directory' && change.before !== null) await durableFile(join(dir, `${i}.before`), change.before);
        await this.save(dir, record); await rename(dir, targetDir); dir = targetDir; published = true; await syncDir(this.location(project));
        for (const [i, change] of changes.entries()) {
          signal?.throwIfAborted();
          record.status = 'applying'; record.next_file = i; await this.save(dir, record);
          await beforeCommit?.(i); // Dependency-injected regression hook; never provided by CLI or model.
          signal?.throwIfAborted();
          if (change.kind === 'directory') {
            const created = await createDirectory(project.tree, root, change.path, files[i].mode);
            files[i].after_identity = created.identity; files[i].mode = created.mode;
            await this.save(dir, record);
          } else {
            await replaceFile(project.tree, root, change.path, change.before_sha256, change.after, files[i].mode, `.m365-edit-tmp-${record.id}-${i}`);
          }
        }
        record.status = 'applied'; delete record.next_file; await this.save(dir, record);
        return this.receipt(record);
      } catch (error) {
        if (!published) { await rm(dir, { recursive: true, force: true }).catch(() => {}); throw failure('backup_failed', 'Cannot prepare the local backup. No source file was modified.', 500); }
        // A write sequence cannot be abandoned simply because AbortSignal fired.
        // Rollback has no request cancellation, but never overwrites a third version.
        try { await this.rollback(project, root, dir, record, 'rolled_back'); }
        catch { record.status = 'recovery_required'; await this.save(dir, record).catch(() => {}); throw failure('workspace_recovery_required', `Change ${record.id} was interrupted; guarded rollback could not finish. Backups were retained. Run m365proxy undo --change-id ${record.id}.`); }
        if (error instanceof ProxyError || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
        throw failure('write_failed', `Change ${record.id} failed and was rolled back. Original backups remain in the local state directory.`, 500);
      }
    });
  }
  async rollback(project, root, dir, record, finalStatus) {
    const restore = [];
    for (const [i, file] of record.files.entries()) {
      if (file.kind === 'directory') {
        const current = await currentDirectory(project.tree, root, file.path);
        if (!current) continue;
        if (!file.after_identity || current.identity !== file.after_identity) throw failure('undo_conflict', 'A created directory has a different identity. It was not removed by undo.');
        restore.push({ ...file, index: i });
        continue;
      }
      const current = await currentFile(project.tree, root, file.path);
      if (hash(current) === file.before_sha256) continue;
      let text = null;
      if (file.before_sha256 !== null) {
        const backup = await secureRead(join(dir, `${i}.before`), LIMIT);
        if (!backup || backup.sha256 !== file.before_sha256) throw failure('backup_corrupt', 'The backup is missing or its hash does not match.');
        text = backup.text;
      }
      if (hash(current) !== file.after_sha256) throw failure('undo_conflict', 'A local file has a third version. It was not overwritten by undo.');
      restore.push({ ...file, text, index: i });
    }
    record.status = 'rolling_back'; await this.save(dir, record);
    for (const file of restore.reverse()) {
      if (file.kind === 'directory') await removeDirectory(project.tree, root, file.path, file.after_identity);
      else await replaceFile(project.tree, root, file.path, file.after_sha256, file.text, file.mode, `.m365-edit-tmp-${record.id}-restore-${file.index}`);
    }
    await this.cleanTemps(project, root, record);
    record.status = finalStatus; delete record.next_file; await this.save(dir, record);
  }
  async cleanTemps(project, root, record) {
    for (const [i, file] of record.files.entries()) {
      if (file.kind === 'directory') continue;
      try {
        await withParent(project.tree, root, file.path, false, async (_, parent) => {
          for (const name of [`.m365-edit-tmp-${record.id}-${i}`, `.m365-edit-tmp-${record.id}-restore-${i}`]) {
            const path = `/proc/self/fd/${parent.fd}/${name}`;
            let fd;
            try { fd = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
            catch (e) { if (e.code === 'ENOENT') continue; throw failure('recovery_temp_unsafe', 'A transaction temporary path is unsafe.'); }
            try {
              const stat = await fd.stat();
              if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw failure('recovery_temp_unsafe', 'A transaction temporary file was replaced.');
              await unlink(path); await parent.sync();
            } finally { await fd.close(); }
          }
        });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  async undo(project, id, { signal } = {}) {
    return project.tree.withRoot(async (root) => {
      await lockDirectory(root.fd, signal);
      const { dir, record } = await this.read(project, id);
      if (['undone', 'rolled_back'].includes(record.status)) return { change_id: id, restored: true, already_restored: true, executed_commands: false };
      signal?.throwIfAborted();
      // Once restoration starts it runs to completion/recovery, not in a detached
      // Promise after cancellation. As with apply, there is no confirmation prompt.
      await this.rollback(project, root, dir, record, 'undone');
      return { change_id: id, restored: true, executed_commands: false, files: record.files.map((f) => f.path) };
    });
  }
}
