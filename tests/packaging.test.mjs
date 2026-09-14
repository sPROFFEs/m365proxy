// Offline packaging integration. The Git repository here is a synthetic fixture,
// NOT cramt, and never substitutes for the separately skipped upstream test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../', import.meta.url));
function entries(buffer) {
  const result = new Map(); let pos = 0;
  while (buffer.readUInt32LE(pos) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(pos + 8), 0, 'fixture expects stored ZIP entries');
    const size = buffer.readUInt32LE(pos + 18), n = buffer.readUInt16LE(pos + 26), x = buffer.readUInt16LE(pos + 28);
    const name = buffer.subarray(pos + 30, pos + 30 + n).toString();
    assert.ok(!result.has(name), 'no duplicate entries');
    const start = pos + 30 + n + x;
    result.set(name, buffer.subarray(start, start + size)); pos = start + size;
  }
  assert.equal(buffer.readUInt32LE(pos), 0x02014b50);
  return result;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'copilot-pack-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(source, 'scripts'), join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'hello.mjs'), 'export const hello = true;\n');
  await writeFile(join(root, 'src', 'api-key'), 'DO_NOT_SHIP_THIS_KEY');
  await writeFile(join(root, 'src', 'guided.json'), 'DO_NOT_SHIP_LOCAL_PROFILE');
  await writeFile(join(root, 'src', '.guided-test.tmp'), 'DO_NOT_SHIP_LOCAL_PROFILE_TEMP');
  await writeFile(join(root, 'src', 'process.guard'), 'DO_NOT_SHIP_GUARD');
  await writeFile(join(root, 'src', '.process-lock-test.tmp'), 'DO_NOT_SHIP_LOCK_TEMP');
  await writeFile(join(root, 'src', 'private.log'), 'DO_NOT_SHIP_THIS_LOG');
  await mkdir(join(root, 'src', 'browser-profile'));
  await writeFile(join(root, 'src', 'browser-profile', 'Cookies'), 'DO_NOT_SHIP_COOKIES');
  await writeFile(join(root, 'LICENSE'), 'Synthetic local test license\n');
  await writeFile(join(root, 'README.md'), 'Synthetic package\n');
  await writeFile(join(root, 'UPSTREAM.json'), JSON.stringify({ repository: 'https://example.invalid/test.git', commit: 'unused', destination: 'vendor/cramt', bundledInThisZip: false }));
  return root;
}
function run(script, args = []) { return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20000 }); }

test('extension-only ZIP uses allowlist and excludes browser/session state', async (t) => {
  const root = await fixture(t);
  const result = run(join(root, 'scripts/pack.mjs'));
  assert.equal(result.status, 0, result.stderr);
  const zip = entries(await readFile(join(root, 'm365-copilot-local.zip')));
  assert.ok(zip.has('m365-copilot-local/src/hello.mjs'));
  assert.equal(JSON.parse(zip.get('m365-copilot-local/UPSTREAM.json')).bundledInThisZip, false);
  assert.ok(![...zip.keys()].some((name) => /api-key|private.log|browser-profile/.test(name)));
  assert.ok(!Buffer.concat([...zip.values()]).toString().includes('DO_NOT_SHIP'));
});

test('full ZIP pins tracked fixture sources and bootstrap verifies extracted hashes offline', async (t) => {
  const root = await fixture(t), vendor = join(root, 'vendor/cramt');
  await mkdir(join(vendor, 'src'), { recursive: true });
  await writeFile(join(vendor, 'LICENSE'), 'Synthetic upstream test license\n');
  await writeFile(join(vendor, 'src', 'upstream.mjs'), 'export const fixture = true;\n');
  const git = (args) => execFileSync('git', args, { cwd: vendor, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  await writeFile(join(root, 'UPSTREAM.json'), JSON.stringify({ repository: 'https://example.invalid/test.git', commit, destination: 'vendor/cramt', bundledInThisZip: false }));
  // An old manifest must not create duplicate ZIP entries.
  await writeFile(join(root, 'UPSTREAM_FILES_SHA256.json'), '{}');
  await writeFile(join(vendor, 'runtime-secret'), 'DO_NOT_SHIP_UNTRACKED');
  const packed = run(join(root, 'scripts/pack.mjs'), ['--require-upstream']);
  assert.equal(packed.status, 0, packed.stderr);
  const zip = entries(await readFile(join(root, 'm365-copilot-local-full-source.zip')));
  assert.equal(JSON.parse(zip.get('m365-copilot-local/UPSTREAM.json')).bundledInThisZip, true);
  assert.ok(zip.has('m365-copilot-local/vendor/cramt/LICENSE'));
  assert.ok(![...zip.keys()].some((name) => /runtime-secret|\/\.git\//.test(name)));
  const dest = join(root, 'unpacked');
  for (const [name, bytes] of zip) { const path = join(dest, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  const script = join(dest, 'm365-copilot-local/scripts/bootstrap.mjs');
  const verified = run(script, ['--sources-only']);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.match(verified.stdout, /Verified bundled source snapshot/);
  await writeFile(join(dest, 'm365-copilot-local/vendor/cramt/src/upstream.mjs'), 'modified\n');
  const tampered = run(script, ['--sources-only']);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /hash mismatch/);
});
