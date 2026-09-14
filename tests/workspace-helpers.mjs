import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceManager } from '../src/workspace.mjs';
import { config } from './helpers.mjs';
const key = 'test-workspace-key';
export async function treeFixture(t, content = { 'src/app.js': 'const value = 1;\n', 'README.md': '# Project\n' }, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'm365-workspace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(content)) { await mkdir(dirname(join(dir, name)), { recursive: true }); await writeFile(join(dir, name), text); }
  const settings = { ...config, workspaceRoot: dir, contextMode: 'read', ...options };
  const manager = await WorkspaceManager.fromConfig(settings, key);
  return { dir, manager, project: manager.select(), settings };
}

