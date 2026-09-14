// Text proposals only. This module never writes project files, invokes a shell,
// runs git apply, installs dependencies, or executes proposed code.
import { createHmac, randomUUID } from 'node:crypto';
import { ProxyError } from './errors.mjs';
import { sha256, safeEqual, stable, plainObject } from './util.mjs';
import { sourcePath, validRelative, containsSecret } from './workspace-files.mjs';
const bad = (message) => new ProxyError(502, 'patch_contract_error', message);
const conflict = (message) => new ProxyError(409, 'patch_base_changed', message);

export const patchInstruction = `\nPATCH PROPOSAL MODE. No local tools are available and no changes will be applied.
For a requested edit return exactly one fenced diff block containing a standard unified diff.
Use --- a/relative/path and +++ b/relative/path, or /dev/null for a new/deleted file.
Include accurate @@ hunk ranges and exact context from the complete snapshot below.
Only edit/delete files whose full text is included. New UTF-8 source files may be proposed.
No renames, binary diffs, file modes, shell commands, tool envelopes or absolute paths.
Never say a change was saved or a test ran. If no change is justified, explain why without a diff.
Text outside the one diff block is explanatory only. The local client will review the proposal.\n`;

function pathOf(header, prefix) {
  if (header === '/dev/null') return null;
  if (!header.startsWith(prefix) || !validRelative(header.slice(prefix.length)) || !sourcePath(header.slice(prefix.length)))
    throw bad('A patch path is unsupported or outside the approved source policy.');
  return header.slice(prefix.length);
}
export function extractDiff(text) {
  const matches = [...text.matchAll(/^```(?:diff|patch)\s*\n([\s\S]*?)^```\s*$/gm)];
  if (matches.length > 1) throw bad('Return one diff block, not multiple proposed patches.');
  if (matches.length === 1) return matches[0][1].replace(/\r\n/g, '\n');
  if (/^--- a\//m.test(text) || text.startsWith('--- /dev/null\n') || text.startsWith('diff --git ')) return text.replace(/\r\n/g, '\n');
  if (/```(?:diff|patch)|<<<(?:END_)?LOCAL_TOOLS:/i.test(text)) throw bad('Incomplete diff block or a tool envelope appeared in patch mode.');
  return null;
}
export function parseDiff(patch) {
  if (typeof patch !== 'string' || !patch || patch.length > 524288 || containsSecret(patch)) throw bad('The proposed diff is empty, too large, or matched the secret heuristic.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(patch)) throw bad('Binary/control characters are not allowed in a patch.');
  const lines = patch.split('\n'); if (lines.at(-1) === '') lines.pop();
  const files = []; let i = 0;
  while (i < lines.length) {
    if (lines[i] === '') { i++; continue; }
    if (lines[i].startsWith('diff --git ')) {
      if (!/^diff --git a\/[^\t]+ b\/[^\t]+$/.test(lines[i++])) throw bad('Invalid git diff header.');
      if (lines[i]?.startsWith('index ')) { if (!/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100644)?$/.test(lines[i++])) throw bad('Unsupported index or mode line.'); }
    }
    if (!lines[i]?.startsWith('--- ') || !lines[i + 1]?.startsWith('+++ ')) throw bad('Expected paired unified-diff file headers; binary/mode/rename patches are not supported.');
    const oldPath = pathOf(lines[i++].slice(4), 'a/'), newPath = pathOf(lines[i++].slice(4), 'b/');
    if ((!oldPath && !newPath) || (oldPath && newPath && oldPath !== newPath)) throw bad('Rename/copy patches are not supported.');
    const path = oldPath ?? newPath;
    if (files.some((f) => f.path === path) || files.length >= 64) throw bad('Duplicate paths or too many files in a patch.');
    const hunks = [];
    while (lines[i]?.startsWith('@@ ')) {
      const match = lines[i++].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
      if (!match) throw bad('Invalid unified-diff hunk header.');
      const [oldStart, oldCount, newStart, newCount] = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
      if ([oldStart, oldCount, newStart, newCount].some((n) => !Number.isSafeInteger(n) || n > 1000000)) throw bad('Hunk bounds exceed the local limit.');
      let oldSeen = 0, newSeen = 0; const entries = [];
      while (i < lines.length && (oldSeen < oldCount || newSeen < newCount)) {
        const line = lines[i++], kind = line[0];
        if (![' ', '+', '-'].includes(kind)) throw bad('Hunk contents do not match the declared line counts.');
        entries.push({ kind, text: line.slice(1) + '\n' });
        if (kind !== '+') oldSeen++; if (kind !== '-') newSeen++;
        if (lines[i] === '\\ No newline at end of file') { entries.at(-1).text = line.slice(1); i++; }
        if (oldSeen > oldCount || newSeen > newCount) throw bad('Hunk contains too many lines.');
      }
      if (oldSeen !== oldCount || newSeen !== newCount || !entries.some((e) => e.kind !== ' ')) throw bad('Incomplete or unchanged hunk.');
      hunks.push({ oldStart, oldCount, newStart, newCount, entries });
    }
    if (!hunks.length) throw bad('Every file patch must contain a real text hunk.');
    files.push({ path, oldPath, newPath, hunks });
  }
  if (!files.length) throw bad('No supported file changes were found.');
  return files;
}
const splitLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
export function validateHunks(file, original) {
  const input = splitLines(original), output = []; let cursor = 0;
  for (const hunk of file.hunks) {
    const start = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart;
    const newStart = hunk.newCount ? hunk.newStart - 1 : hunk.newStart;
    if (start < cursor || start > input.length) throw bad('Hunk offset is outside the supplied base file.');
    output.push(...input.slice(cursor, start)); cursor = start;
    if (newStart !== output.length) throw bad('New hunk offset is inconsistent with the prior changes.');
    for (const entry of hunk.entries) {
      if (entry.kind !== '+') {
        if (input[cursor] !== entry.text) throw bad('Hunk context/deletions do not match the snapshot exactly.');
        cursor++;
      }
      if (entry.kind !== '-') output.push(entry.text);
    }
  }
  output.push(...input.slice(cursor));
  if (!file.newPath && output.length) throw bad('A delete-file patch must delete the complete file.');
  if (output.join('') === original && file.oldPath && file.newPath) throw bad('The proposal does not change the file.');
  return output.join(''); // Only used to validate; never written to disk.
}
function unsigned(bundle) { const { signature, ...rest } = bundle; return rest; }
function sign(bundle, key) { return createHmac('sha256', key).update('m365proxy.patch.v1\n' + stable(unsigned(bundle))).digest('hex'); }
async function readBase(tree, path, maxBytes, signal) {
  try { return await tree.read(path, maxBytes, { signal }); }
  catch (e) { if (e.code === 'ENOENT') return null; throw conflict('A proposed path is no longer a safe, readable source file. Refresh the context.'); }
}
export async function buildProposal(text, snapshot, project, key, { signal, now = Date.now() } = {}) {
  const patch = extractDiff(text);
  if (patch === null) return null;
  const changes = parseDiff(patch), bases = [];
  for (const change of changes) {
    signal?.throwIfAborted();
    if (!project.tree.allowed(change.path)) throw bad('A patch path is protected.');
    const source = snapshot.selected.find((f) => f.path === change.path);
    const current = await readBase(project.tree, change.path, project.maxFileBytes, signal);
    if (change.oldPath) {
      if (!source) throw bad('Edit/delete proposals must refer to a file included in full in this snapshot.');
      if (!current || current.sha256 !== source.sha256) throw conflict('A touched file changed while Copilot generated the proposal. No patch was applied.');
      validateHunks(change, source.text);
      bases.push({ path: change.path, sha256: source.sha256 });
    } else {
      if (current) throw conflict('A proposed new file already exists. No patch was applied.');
      if (project.pathIgnored(change.path, snapshot.rules)) throw bad('A new file is excluded by the project ignore policy.');
      validateHunks(change, ''); bases.push({ path: change.path, sha256: null });
    }
  }
  const bundle = { format: 'm365proxy.patch.v1', id: randomUUID(), project_id: project.id,
    root_fingerprint: project.fingerprint, snapshot_id: snapshot.id,
    created_at: new Date(now).toISOString(), expires_at: new Date(now + 86400000).toISOString(),
    base_files: bases, patch, patch_sha256: sha256(patch), applied: false };
  return { ...bundle, signature: sign(bundle, key) };
}
export async function checkProposal(bundle, project, key, { signal, now = Date.now() } = {}) {
  if (!plainObject(bundle) || bundle.format !== 'm365proxy.patch.v1' || !safeEqual(bundle.signature, sign(bundle, key)))
    throw new ProxyError(400, 'patch_signature', 'The proposal is not an intact bundle signed by this proxy API key.');
  if (bundle.project_id !== project.id || bundle.root_fingerprint !== project.fingerprint)
    throw new ProxyError(409, 'patch_project_mismatch', 'The proposal belongs to another configured project.');
  if (!Number.isFinite(Date.parse(bundle.expires_at)) || Date.parse(bundle.expires_at) < now) throw new ProxyError(409, 'patch_expired', 'This proposal expired. Generate a fresh one.');
  if (sha256(bundle.patch) !== bundle.patch_sha256) throw bad('Patch checksum mismatch.');
  const changes = parseDiff(bundle.patch);
  if (changes.length !== bundle.base_files?.length) throw bad('Invalid base-file manifest.');
  for (const change of changes) {
    const base = bundle.base_files.find((f) => f.path === change.path);
    if (!base || !project.tree.allowed(change.path)) throw bad('Invalid proposal path.');
    const current = await readBase(project.tree, change.path, project.maxFileBytes, signal);
    if ((current?.sha256 ?? null) !== base.sha256) throw conflict('The base has changed since this proposal was generated. Do not apply this patch.');
    validateHunks(change, current?.text ?? '');
  }
  return { valid: true, applied: false, executed_commands: false, proposal_id: bundle.id,
    project_id: project.id, files: changes.map((f) => f.path),
    note: 'Checks passed at this moment. No file was changed; review again before any manual application.' };
}
