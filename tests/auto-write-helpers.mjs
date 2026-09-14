import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { WorkspaceManager } from '../src/workspace.mjs';
import { parseAutoEdits } from '../src/auto-edits.mjs';
import { config as base } from './helpers.mjs';
import { sha256 } from '../src/util.mjs';

export async function fixture(t, contents = { 'src/main.js': 'const value = 1;\n' }, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'm365-auto-'));
  const root = join(dir, 'project'), state = join(dir, 'state');
  await mkdir(root); await mkdir(state, { mode: 0o700 });
  for (const [path, text] of Object.entries(contents)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
  const config = { ...base, workspaceRoot: root, stateDir: state, writeMode: 'auto', contextMode: 'read', requestTimeoutMs: 10000, ...options };
  const manager = await WorkspaceManager.fromConfig(config, 'test-key-'.repeat(8));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = manager.select();
  return { dir, root, state, config, manager, project, snapshot: () => project.snapshot('main') };
}
export const edits = (snapshot, changes) => 'Cambios propuestos.\n```m365-edit\n' + JSON.stringify({ format: 'm365proxy.edit.v1', snapshot_id: snapshot.id, changes }) + '\n```';
export const reply = (prompt, changes) => edits({ id: prompt.match(/snapshot_[a-f0-9]{64}/)[0] }, changes);
export const write = (path, content) => ({ action: 'write', path, content });
export async function save(f, changes, opts = {}) {
  const s = await f.snapshot(); const plan = parseAutoEdits(edits(s, changes), s, f.project);
  return f.manager.writer.apply(f.project, s, plan.changes, { requestFingerprint: sha256(JSON.stringify(changes)), ...opts });
}

