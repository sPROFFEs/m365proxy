// Minimal ZIP writer (stored entries, UTF-8 filenames). No external packages.
// All runtime state is excluded by an explicit allowlist, not a broad directory walk.
import { readFile, readdir, lstat, readlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = 'm365-copilot-local/';
const manifest = JSON.parse(await readFile(join(root, 'UPSTREAM.json'), 'utf8'));
const full = process.argv.includes('--require-upstream');
const files = [];
async function add(path, tracked = false) {
  if (!tracked && (['changes', 'profiles', 'api-key', 'guided.json', 'process.lock', 'process.guard', 'browser-profile', 'secrets.json', 'msal-cache.json', '.env', 'node_modules', '.git'].includes(basename(path)) || /\.(?:log|zip)$/.test(path) || /^\.(?:process-lock|guided|record|m365-edit-tmp)-.*\.tmp$/.test(basename(path)))) return;
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    if (tracked) throw new Error('A tracked directory/submodule cannot be bundled as a flat source snapshot.');
    for (const name of (await readdir(path)).sort()) await add(join(path, name));
  } else {
    files.push({ name: prefix + relative(root, path).replaceAll('\\', '/'), data: stat.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path), mode: stat.mode });
  }
}
for (const entry of ['src', 'scripts', 'tests', 'examples', 'docs', 'package.json', 'UPSTREAM.json', 'README.md', 'install.sh', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'TEST_REPORT.md', '.gitignore']) {
  try { await add(join(root, entry)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
if (full) {
  const dest = join(root, manifest.destination);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest, encoding: 'utf8' }).trim();
  if (head !== manifest.commit) throw new Error('Upstream commit does not match the pin.');
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dest, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Tracked upstream files were edited. Refusing to label the archive as a pinned snapshot.');
  const sourceHashes = {};
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: dest }).toString().split('\0').filter(Boolean);
  for (const name of names) {
    const path = resolve(dest, name);
    const rel = relative(dest, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Invalid upstream path.');
    const stat = await lstat(path);
    const bytes = stat.isSymbolicLink() ? Buffer.from('symlink:' + await readlink(path)) : await readFile(path);
    sourceHashes[name] = createHash('sha256').update(bytes).digest('hex');
    await add(path, true);
  }
  files.push({ name: prefix + 'UPSTREAM_FILES_SHA256.json', data: Buffer.from(JSON.stringify({ commit: manifest.commit, files: sourceHashes }, null, 2) + '\n'), mode: 0o100644 });
  const m = files.find((f) => f.name.endsWith('/UPSTREAM.json'));
  m.data = Buffer.from(JSON.stringify({ ...manifest, bundledInThisZip: true, note: 'Full pinned source tree included; npm dependencies and browser binaries still require installation.' }, null, 2) + '\n');
} else {
  const m = files.find((f) => f.name.endsWith('/UPSTREAM.json'));
  m.data = Buffer.from(JSON.stringify({ ...manifest, bundledInThisZip: false, note: 'This archive contains the local extension and bootstrap. npm run setup fetches the entire pinned upstream source tree.' }, null, 2) + '\n');
}
if (new Set(files.map((f) => f.name)).size !== files.length) throw new Error('Duplicate ZIP entry.');
if (files.length > 65535) throw new Error('Too many entries for this non-ZIP64 writer.');
const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
function crc32(buf) { let c = 0xffffffff; for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const parts = [], central = []; let offset = 0;
for (const file of files) {
  const name = Buffer.from(file.name); const data = file.data; const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(33, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(33, 14);
  record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE((file.mode << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
  parts.push(local, name, data); central.push(record, name); offset += local.length + name.length + data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const target = join(root, full ? 'm365-copilot-local-full-source.zip' : 'm365-copilot-local.zip');
await writeFile(target, Buffer.concat([...parts, directory, end]));
console.log(`${target}\n${files.length} files; upstream source included: ${full}`);
