import { readFile, mkdir, access, lstat, readlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { run, pnpm } from './process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'UPSTREAM.json'), 'utf8'));
const dest = join(root, manifest.destination);
const sourcesOnly = process.argv.includes('--sources-only');
const skipBrowser = process.argv.includes('--skip-browser');
try {
  if (!sourcesOnly && Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required by upstream. Upgrade Node before setup.');
  await run('git', ['--version'], { quiet: true });
  await mkdir(dest, { recursive: true });
  let exists = true;
  try { await access(join(dest, '.git')); } catch { exists = false; }
  if (!exists && manifest.bundledInThisZip) {
    const hashes = JSON.parse(await readFile(join(root, 'UPSTREAM_FILES_SHA256.json'), 'utf8'));
    if (hashes.commit !== manifest.commit || !hashes.files['LICENSE']) throw new Error('Invalid bundled-source manifest.');
    for (const [name, expected] of Object.entries(hashes.files)) {
      const path = resolve(dest, name), rel = relative(dest, path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('Invalid bundled-source path.');
      const stat = await lstat(path);
      const bytes = stat.isSymbolicLink() ? Buffer.from('symlink:' + await readlink(path)) : await readFile(path);
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Bundled-source hash mismatch: ' + name);
    }
    console.log(`Verified bundled source snapshot: ${manifest.commit}`);
  } else {
    if (!exists) {
      await run('git', ['init'], { cwd: dest });
      await run('git', ['config', 'core.autocrlf', 'false'], { cwd: dest });
      await run('git', ['remote', 'add', 'origin', manifest.repository], { cwd: dest });
    }
    const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: dest, quiet: true });
    if (remote !== manifest.repository) throw new Error('Existing vendor/cramt points at a different repository. Refusing to overwrite it.');
    let head;
    try { head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dest, quiet: true }); } catch { head = null; }
    if (!head) {
      await run('git', ['fetch', '--depth', '1', 'origin', manifest.commit], { cwd: dest });
      await run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: dest });
      head = await run('git', ['rev-parse', 'HEAD'], { cwd: dest, quiet: true });
    }
    if (head !== manifest.commit) throw new Error('Existing checkout is not the pinned revision. No files were overwritten.');
    const changes = await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dest, quiet: true });
    if (changes) throw new Error('The upstream tracked files have local edits. Refusing to install against an unverified tree.');
    console.log(`Verified upstream commit: ${head}`);
  }
  await access(join(dest, 'LICENSE'));
  if (!sourcesOnly) {
    await pnpm(['install', '--frozen-lockfile'], dest);
    await pnpm(['build'], dest);
    if (!skipBrowser) await pnpm(['--filter', '@m365-copilot/core', 'exec', 'playwright', 'install', 'chromium'], dest);
    await run(process.execPath, ['scripts/verify-upstream.mjs'], { cwd: root });
    console.log('Setup completed. Next: npm run serve. No Microsoft account was contacted by the setup script itself.');
  } else console.log('Full pinned source tree fetched. Dependencies and browser binaries have not been installed.');
} catch (error) {
  console.error(`SETUP FAILED: ${error.message}`);
  console.error('This command needs access to GitHub/npm/Playwright downloads. It does not require Microsoft tenant administration.');
  process.exitCode = 1;
}
