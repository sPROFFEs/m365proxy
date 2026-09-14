// Real-process crash fixture. No Microsoft, credentials or network requests.
import { WorkspaceManager } from '../../src/workspace.mjs';
import { parseAutoEdits } from '../../src/auto-edits.mjs';
const [root, stateDir] = process.argv.slice(2);
const manager = await WorkspaceManager.fromConfig({ workspaceRoot: root, stateDir, contextMode: 'read', writeMode: 'auto' }, 'test-key-'.repeat(8));
const project = manager.select(), snapshot = await project.snapshot();
const text = '```m365-edit\n' + JSON.stringify({ format: 'm365proxy.edit.v1', snapshot_id: snapshot.id,
  changes: [{ action: 'write', path: 'a.js', content: 'A' }, { action: 'write', path: 'b.js', content: 'B' }] }) + '\n```';
const plan = parseAutoEdits(text, snapshot, project);
await manager.writer.apply(project, snapshot, plan.changes, { requestFingerprint: 'crash-fixture', beforeCommit: async (i) => {
  if (i === 1) { process.send?.('first-written'); setInterval(() => {}, 1000); await new Promise(() => {}); }
} });
