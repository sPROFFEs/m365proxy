import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDiff, validateHunks, buildProposal, checkProposal, extractDiff } from '../src/patch-proposals.mjs';
import { treeFixture } from './workspace-helpers.mjs';
const patch = '--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n';
const answer = 'Proposed change only.\n```diff\n' + patch + '```\n';
async function proposal(t) {
  const f = await treeFixture(t, undefined, { contextMode: 'patch' });
  const snapshot = await f.manager.snapshot();
  const bundle = await buildProposal(answer, snapshot, f.project, f.manager.key);
  return { ...f, bundle, snapshot };
}
test('valid patch is signed and checked but source remains unchanged', async (t) => {
  const f = await proposal(t); assert.equal(f.bundle.applied, false); assert.equal(f.bundle.patch, patch);
  assert.equal((await f.manager.check(f.bundle)).valid, true);
  assert.equal(await readFile(join(f.dir, 'src/app.js'), 'utf8'), 'const value = 1;\n');
});
test('proposal changing an existing file detects later edits before validation', async (t) => {
  const f = await proposal(t); await writeFile(join(f.dir, 'src/app.js'), 'const value = 3;\n');
  await assert.rejects(f.manager.check(f.bundle), { code: 'patch_base_changed' });
});
test('a file changed during model generation prevents returning a successful proposal', async (t) => {
  const f = await treeFixture(t); const snap = await f.manager.snapshot();
  await writeFile(join(f.dir, 'src/app.js'), 'const value = 3;\n');
  await assert.rejects(buildProposal(answer, snap, f.project, f.manager.key), { code: 'patch_base_changed' });
});
test('tampered bundle, another API key, expired bundle and another project are rejected', async (t) => {
  const f = await proposal(t);
  await assert.rejects(f.manager.check({ ...f.bundle, patch: patch + 'BOGUS' }), { code: 'patch_signature' });
  await assert.rejects(checkProposal(f.bundle, f.project, 'different-key'), { code: 'patch_signature' });
  await assert.rejects(checkProposal(f.bundle, f.project, f.manager.key, { now: Date.now() + 86400001 }), { code: 'patch_expired' });
  await assert.rejects(checkProposal(f.bundle, { ...f.project, id: 'different' }, f.manager.key), { code: 'patch_project_mismatch' });
});
test('symlink substitution after proposal is rejected without reading its target', async (t) => {
  const f = await proposal(t); await rm(join(f.dir, 'src/app.js')); await symlink('/etc/passwd', join(f.dir, 'src/app.js'));
  await assert.rejects(f.manager.check(f.bundle), { code: 'patch_base_changed' });
});
test('ignore policy changes invalidate a signed proposal', async (t) => {
  const f = await proposal(t); await writeFile(join(f.dir, '.m365ignore'), 'src/app.js\n');
  await assert.rejects(f.manager.check(f.bundle), { code: 'patch_policy_changed' });
});
test('new file is validated only if absent and not excluded', async (t) => {
  const f = await treeFixture(t); const snap = await f.manager.snapshot();
  const text = '```diff\n--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+const added = true;\n```';
  const bundle = await buildProposal(text, snap, f.project, f.manager.key);
  assert.equal(bundle.base_files[0].sha256, null); assert.equal((await f.manager.check(bundle)).applied, false);
  await writeFile(join(f.dir, 'src/new.js'), 'already exists\n');
  await assert.rejects(buildProposal(text, snap, f.project, f.manager.key), { code: 'patch_base_changed' });
});
test('a patch cannot edit an unselected file or propose ignored new files', async (t) => {
  const f = await treeFixture(t, { 'src/app.js': 'const value = 1;\n', '.m365ignore': 'ignored.js\n' });
  const snap = await f.manager.snapshot();
  await assert.rejects(buildProposal(answer, { ...snap, selected: [] }, f.project, f.manager.key), { code: 'patch_contract_error' });
  const newPatch = '--- /dev/null\n+++ b/ignored.js\n@@ -0,0 +1 @@\n+const added = true;\n';
  await assert.rejects(buildProposal(newPatch, snap, f.project, f.manager.key), { code: 'patch_contract_error' });
});
test('malformed hunks, traversal, renames, binary patches and mode changes are rejected', () => {
  for (const p of [patch.replace('a/src/app.js', 'a/../../secret'), patch.replace('b/src/app.js', 'b/new.js'),
    patch.replace('@@ -1 +1 @@', '@@ -1,2 +1 @@'), 'GIT binary patch\n', 'old mode 100644\nnew mode 100755\n',
    patch.replace('src/app.js', '.env')]) assert.throws(() => parseDiff(p), { code: 'patch_contract_error' });
  assert.throws(() => validateHunks(parseDiff(patch)[0], 'different\n'), { code: 'patch_contract_error' });
});
test('multiple files, deletion, zero-range insertion and missing newline markers validate as text', () => {
  const multi = patch + '--- a/delete.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
  const parsed = parseDiff(multi); assert.equal(parsed.length, 2); assert.equal(validateHunks(parsed[1], 'gone\n'), '');
  const nonewline = '--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
  assert.equal(validateHunks(parseDiff(nonewline)[0], 'old'), 'new');
});
test('prose without a diff remains prose; incomplete or repeated diff blocks are not valid proposals', () => {
  assert.equal(extractDiff('I need the missing file before proposing an edit.'), null);
  assert.throws(() => extractDiff(answer + answer));
  assert.throws(() => extractDiff('```diff\n--- incomplete'));
});
