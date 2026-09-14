// Tests of the REAL installer/launcher with explicitly synthetic build/network
// commands. These do NOT install packages or contact Microsoft/GitHub/npm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, readFile, readlink, readdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathBlock, stripBlock } from '../scripts/linux-path.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
const common = join(source, 'scripts/linux/common.sh');
const installer = join(source, 'install.sh');
const linux = process.platform === 'linux';
const ordinaryUser = linux && process.getuid?.() !== 0;
const runtimeArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
}
function bash(code, options = {}) { return run('bash', ['-c', code], options); }
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'm365-linux-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function helper(code) { return bash(`source ${quote(common)}; ${code}`); }

test('Linux scripts have valid Bash syntax', { skip: !linux }, () => {
  for (const script of [installer, common, join(source, 'scripts/linux/launcher.sh')]) {
    const result = run('bash', ['-n', script]); assert.equal(result.status, 0, result.stderr);
  }
});
test('installer help works without downloads or prerequisites', { skip: !linux }, () => {
  const result = run('bash', [installer, '--help']); assert.equal(result.status, 0); assert.match(result.stdout, /WITHOUT sudo/);
});
test('architecture mapping accepts x64 and arm64, rejects armv7', { skip: !linux }, () => {
  assert.equal(helper('m365_arch x86_64').stdout.trim(), 'x64');
  assert.equal(helper('m365_arch aarch64').stdout.trim(), 'arm64');
  assert.notEqual(helper('m365_arch armv7l').status, 0);
});
test('Debian-family detection is permissive and includes Parrot derivatives', { skip: !linux }, () => {
  for (const args of ["debian ''", "kali debian", "parrot debian", "linuxmint 'ubuntu debian'", "custom 'debian testing'"]) assert.equal(helper(`m365_is_debian_like ${args}`).status, 0);
  assert.notEqual(helper("m365_is_debian_like alpine ''").status, 0);
});
test('apt candidates prefer t64 and fall back to legacy names, not virtual packages', { skip: !linux }, () => {
  const t64 = helper('apt-cache() { if [[ "$2" == libasound2t64 ]]; then echo "Candidate: 1.2"; else echo "Candidate: (none)"; fi; }; m365_candidate libasound2t64 libasound2');
  assert.equal(t64.status, 0); assert.equal(t64.stdout.trim(), 'libasound2t64');
  const old = helper('apt-cache() { if [[ "$2" == libasound2 ]]; then echo "Candidate: 1.2"; else echo "Candidate: (none)"; fi; }; m365_candidate libasound2t64 libasound2');
  assert.equal(old.stdout.trim(), 'libasound2');
  assert.notEqual(helper('apt-cache() { echo "Candidate: (none)"; }; m365_candidate absent').status, 0);
});
test('Node manifest selects exactly one glibc Node 24 archive', { skip: !linux }, async (t) => {
  const dir = await temp(t), file = join(dir, 'SHASUMS256.txt'), hash = 'a'.repeat(64);
  await writeFile(file, `${hash}  node-v24.0.1-linux-x64.tar.xz\n${hash}  node-v24.0.1-linux-arm64.tar.xz\n${hash}  node-v24.0.1-linux-x64-musl.tar.xz\n`);
  const r = helper(`m365_checksum_entry ${quote(file)} x64 latest`);
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), `${hash} node-v24.0.1-linux-x64.tar.xz`);
  assert.notEqual(helper(`m365_checksum_entry ${quote(file)} x64 24.0.2`).status, 0);
  await writeFile(file, `${hash}  node-v24.0.1-linux-x64.tar.xz\n${hash}  node-v24.0.2-linux-x64.tar.xz\n`);
  assert.notEqual(helper(`m365_checksum_entry ${quote(file)} x64 latest`).status, 0);
});
test('malformed Node checksums are rejected before archive extraction', { skip: !linux }, async (t) => {
  const dir = await temp(t), file = join(dir, 'manifest');
  await writeFile(file, `${'z'.repeat(64)}  node-v24.0.1-linux-x64.tar.xz\n`);
  assert.notEqual(helper(`m365_checksum_entry ${quote(file)} x64 latest`).status, 0);
});
test('installer dry-run has no filesystem side effects', { skip: !linux }, async (t) => {
  const dir = await temp(t);
  const r = run('bash', [installer, '--dry-run', '--prefix', join(dir, 'not-created'), '--bin-dir', join(dir, 'no-bin')]);
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(await readdir(dir), []);
});
test('installer rejects unknown flags, incomplete values and wrong Node version', { skip: !linux }, () => {
  for (const args of [['--bogus'], ['--prefix'], ['--node-version', '22.1.0'], ['--node-version', '24.1.0', '--use-system-node']]) {
    assert.notEqual(run('bash', [installer, ...args]).status, 0);
  }
});
test('PATH block quotes spaces and apostrophes and is idempotent in a shell', { skip: !linux }, async (t) => {
  const dir = await temp(t), bin = join(dir, "bin space ' quote");
  await mkdir(bin); await writeFile(join(bin, 'm365proxy'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const block = join(dir, 'env.sh'); await writeFile(block, pathBlock(bin));
  const r = bash(`source ${quote(block)}; source ${quote(block)}; command -v m365proxy; printf '%s' "$PATH"`, { env: { ...process.env, PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.split('\n')[0], join(bin, 'm365proxy'));
  assert.equal(r.stdout.split('\n')[1].split(':').filter((x) => x === bin).length, 1);
  assert.equal(stripBlock('before\n' + pathBlock(bin) + 'after\n'), 'before\nafter\n');
  assert.throws(() => stripBlock('# >>> m365proxy PATH >>>\nno end'));
});
test('Bash/Zsh files are backed up, not duplicated, and custom ZDOTDIR is supported', { skip: !linux }, async (t) => {
  const dir = await temp(t), z = join(dir, 'zsh'); await mkdir(z);
  await writeFile(join(dir, '.profile'), 'export KEEP_ME=yes\n');
  await writeFile(join(dir, '.bash_profile'), '# Custom Bash login\n');
  const env = { ...process.env, HOME: dir, ZDOTDIR: z };
  const script = join(source, 'scripts/linux-path.mjs');
  for (let i = 0; i < 2; i++) {
    const r = run(process.execPath, [script, 'add', join(dir, 'bin')], { env }); assert.equal(r.status, 0, r.stderr);
  }
  const profile = await readFile(join(dir, '.profile'), 'utf8');
  assert.match(profile, /KEEP_ME=yes/); assert.equal(profile.split('# >>> m365proxy PATH >>>').length - 1, 1);
  assert.ok((await readdir(dir)).some((n) => n.startsWith('.profile.m365proxy-backup-')));
  assert.match(await readFile(join(z, '.zshrc'), 'utf8'), /m365proxy PATH/);
  assert.match(await readFile(join(dir, '.bash_profile'), 'utf8'), /Custom Bash login/);
  const r = run(process.execPath, [script, 'remove'], { env }); assert.equal(r.status, 0, r.stderr);
  assert.ok(!(await readFile(join(dir, '.profile'), 'utf8')).includes('# >>> m365proxy PATH >>>'));
});
test('PATH integration preserves symlinked dotfiles', { skip: !linux }, async (t) => {
  const dir = await temp(t), target = join(dir, 'dotfile');
  await writeFile(target, '# tracked dotfile\n'); await symlink(target, join(dir, '.bashrc'));
  const r = run(process.execPath, [join(source, 'scripts/linux-path.mjs'), 'add', join(dir, 'bin')], { env: { ...process.env, HOME: dir, ZDOTDIR: dir } });
  assert.equal(r.status, 0, r.stderr); assert.equal(await readlink(join(dir, '.bashrc')), target); assert.match(await readFile(target, 'utf8'), /m365proxy PATH/);
});

async function fixture(t) {
  const dir = await temp(t), src = join(dir, 'source'), home = join(dir, 'home');
  await cp(source, src, { recursive: true, filter: (p) => !/(?:\/vendor(?:\/|$)|\.zip$|\/node_modules(?:\/|$))/.test(p) });
  await mkdir(home);
  const bin = join(dir, 'fake-bin'); await mkdir(bin);
  // Only this test executable pretends to be Node 24; all actual test code runs
  // with the real test-runner Node. Never shipped as a runtime fallback.
  const shim = `#!/usr/bin/env bash\nif [[ "\${1:-}" == -p && "\${2:-}" == process.execPath ]]; then printf '%s\\n' "$0"; exit 0; fi\nif [[ "\${1:-}" == -e && "\${2:-}" == *process.versions.node* ]]; then exit 0; fi\nexec ${quote(process.execPath)} "$@"\n`;
  await writeFile(join(bin, 'node'), shim, { mode: 0o700 });
  await writeFile(join(src, 'scripts/bootstrap.mjs'), 'if(process.env.M365_TEST_BUILD_FAIL)process.exit(42);console.log("SYNTHETIC_BUILD_NOT_CRAMT");\n');
  await writeFile(join(src, 'scripts/browser-setup.mjs'), 'if(process.env.M365_TEST_BROWSER_FAIL && process.argv[2]==="check")process.exit(43);console.log("SYNTHETIC_BROWSER_NO_DOWNLOAD",process.argv[2]);\n');
  await writeFile(join(src, 'src/cli.mjs'), 'console.log(JSON.stringify({command:process.argv[2],args:process.argv.slice(3),cwd:process.cwd(),browserPath:process.env.PLAYWRIGHT_BROWSERS_PATH}));\n');
  const prefix = join(home, 'installation with spaces'), commandDir = join(home, 'bin with spaces');
  const env = { ...process.env, HOME: home, ZDOTDIR: home, PATH: `${bin}:${process.env.PATH}`, DISPLAY: ':SYNTHETIC', M365_LOCAL_STATE_DIR: join(home, '.m365-copilot-local') };
  const args = [join(src, 'install.sh'), '--yes', '--no-system-deps', '--use-system-node', '--prefix', prefix, '--bin-dir', commandDir];
  return { dir, src, home, bin, shim, prefix, commandDir, env, args };
}

test('real installer/launcher works from unrelated cwd and retains key/profile on reinstall (synthetic backend)', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, '.m365-copilot-local/browser-profile'), { recursive: true });
  await writeFile(join(f.home, '.m365-copilot-local/api-key'), 'KEEP_LOCAL_KEY');
  await writeFile(join(f.home, '.m365-copilot-local/browser-profile/Cookies'), 'KEEP_LOCAL_COOKIES');
  let r = run('bash', f.args, { env: f.env }); assert.equal(r.status, 0, r.stdout + r.stderr);
  const current = await readlink(join(f.prefix, 'current'));
  const command = join(f.commandDir, 'm365proxy');
  assert.equal(await readlink(join(f.commandDir, 'm365prox')), join(f.prefix, 'bin/m365proxy'));
  for (const sub of ['menu', 'guided', 'profile', 'profiles']) {
    const guided = run(join(f.commandDir, 'm365prox'), [sub], { env: f.env, cwd: '/' });
    assert.equal(guided.status, 0, guided.stderr); assert.equal(JSON.parse(guided.stdout).command, sub);
  }
  r = run(command, ['key', '--state-dir', './relative path'], { env: f.env, cwd: f.dir });
  assert.equal(r.status, 0, r.stderr); const result = JSON.parse(r.stdout);
  assert.equal(result.command, 'key'); assert.deepEqual(result.args, ['--state-dir', './relative path']); assert.equal(result.cwd, f.dir);
  r = run(command, [], { env: f.env, cwd: '/' }); assert.equal(JSON.parse(r.stdout).command, 'serve');
  r = run(command, ['--port', '9999'], { env: f.env, cwd: '/' }); assert.deepEqual(JSON.parse(r.stdout).args, ['--port', '9999']);
  r = run(command, ['start'], { env: f.env }); assert.equal(JSON.parse(r.stdout).command, 'serve');
  r = run(command, ['serve'], { env: { ...f.env, DISPLAY: '', WAYLAND_DISPLAY: '' } }); assert.notEqual(r.status, 0); assert.match(r.stderr, /No graphical display/);
  r = run(command, ['--headless'], { env: { ...f.env, DISPLAY: '', WAYLAND_DISPLAY: '' } }); assert.equal(r.status, 0, r.stderr);
  r = run('bash', f.args, { env: f.env }); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.notEqual(await readlink(join(f.prefix, 'current')), current);
  assert.equal(await readFile(join(f.home, '.m365-copilot-local/api-key'), 'utf8'), 'KEEP_LOCAL_KEY');
  assert.equal(await readFile(join(f.home, '.m365-copilot-local/browser-profile/Cookies'), 'utf8'), 'KEEP_LOCAL_COOKIES');
  assert.equal((await readFile(join(f.home, '.profile'), 'utf8')).split('# >>> m365proxy PATH >>>').length - 1, 1);
  assert.equal((await stat(f.prefix)).mode & 0o777, 0o700);
});
test('failed build or browser test keeps the previous active release (synthetic backend)', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t); let r = run('bash', f.args, { env: f.env }); assert.equal(r.status, 0, r.stdout + r.stderr);
  const old = await readlink(join(f.prefix, 'current'));
  for (const flag of ['M365_TEST_BUILD_FAIL', 'M365_TEST_BROWSER_FAIL']) {
    r = run('bash', f.args, { env: { ...f.env, [flag]: '1' } });
    assert.notEqual(r.status, 0); assert.equal(await readlink(join(f.prefix, 'current')), old);
  }
});
test('installer refuses unrelated command, arbitrary prefix and active profile lock', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t); await mkdir(f.commandDir); await writeFile(join(f.commandDir, 'm365proxy'), 'DO_NOT_OVERWRITE');
  let r = run('bash', f.args, { env: f.env }); assert.notEqual(r.status, 0); assert.match(r.stderr, /unrelated/);
  assert.equal(await readFile(join(f.commandDir, 'm365proxy'), 'utf8'), 'DO_NOT_OVERWRITE'); await rm(join(f.commandDir, 'm365proxy'));
  await mkdir(f.prefix); await writeFile(join(f.prefix, 'unrelated-data'), 'KEEP');
  r = run('bash', f.args, { env: f.env }); assert.notEqual(r.status, 0); assert.match(r.stderr, /Non-empty prefix/);
  await rm(f.prefix, { recursive: true });
  r = run('bash', f.args, { env: f.env }); assert.equal(r.status, 0, r.stdout + r.stderr);
  const old = await readlink(join(f.prefix, 'current'));
  await mkdir(f.env.M365_LOCAL_STATE_DIR, { recursive: true }); await writeFile(join(f.env.M365_LOCAL_STATE_DIR, 'process.lock'), JSON.stringify({ pid: process.pid, created: 'legacy-live-owner' }));
  r = run('bash', f.args, { env: f.env }); assert.notEqual(r.status, 0); assert.equal(await readlink(join(f.prefix, 'current')), old);
});
test('private Node path verifies checksum and uses versioned download URL (synthetic archive)', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t), root = join(f.dir, `node-v24.0.1-linux-${runtimeArch}`);
  await mkdir(join(root, 'bin'), { recursive: true }); await writeFile(join(root, 'bin/node'), f.shim, { mode: 0o700 });
  const archive = join(f.dir, 'node.tar.xz');
  let r = run('tar', ['-cJf', archive, '-C', f.dir, `node-v24.0.1-linux-${runtimeArch}`]); assert.equal(r.status, 0, r.stderr);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  const curl = `#!/usr/bin/env bash\nurl='';out=''\nwhile (($#)); do case "$1" in https:*) url=$1;; -o) shift;out=$1;; esac;shift;done\nprintf '%s\\n' "$url" >> "$M365_TEST_URLS"\nif [[ "$url" == */SHASUMS256.txt ]];then printf '%s  node-v24.0.1-linux-${runtimeArch}.tar.xz\\n' "$M365_TEST_HASH" > "$out";else cp -- "$M365_TEST_ARCHIVE" "$out";fi\n`;
  await writeFile(join(f.bin, 'curl'), curl, { mode: 0o700 });
  const env = { ...f.env, M365_TEST_ARCHIVE: archive, M365_TEST_HASH: hash, M365_TEST_URLS: join(f.dir, 'urls') };
  const args = f.args.filter((arg) => arg !== '--use-system-node');
  r = run('bash', args, { env }); assert.equal(r.status, 0, r.stdout + r.stderr);
  const release = await readlink(join(f.prefix, 'current'));
  assert.ok((await readFile(join(release, '.node-path'), 'utf8')).includes(`runtime/node-v24.0.1-linux-${runtimeArch}/bin/node`));
  assert.ok((await readFile(env.M365_TEST_URLS, 'utf8')).includes(`release/v24.0.1/node-v24.0.1-linux-${runtimeArch}.tar.xz`));
});
test('archive checksum mismatch fails without activation (synthetic download)', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.bin, 'curl'), `#!/usr/bin/env bash\nurl='';out=''\nwhile (($#));do case "$1" in https:*)url=$1;; -o)shift;out=$1;;esac;shift;done\nif [[ "$url" == */SHASUMS256.txt ]];then printf '%s  node-v24.0.1-linux-${runtimeArch}.tar.xz\\n' ${'0'.repeat(64)} > "$out";else printf 'NOT_THE_ARCHIVE' > "$out";fi\n`, { mode: 0o700 });
  const r = run('bash', f.args.filter((arg) => arg !== '--use-system-node'), { env: f.env });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /checksum verification failed/); assert.ok(!(await readdir(f.prefix)).includes('current'));
});


test('default apt stage limits sudo to system package management (synthetic apt/sudo)', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t), log = join(f.dir, 'sudo-log');
  await writeFile(join(f.bin, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$M365_TEST_SUDO_LOG"\nexit 0\n', { mode: 0o700 });
  await writeFile(join(f.bin, 'apt-cache'), '#!/bin/sh\nprintf "Candidate: 1.0\\n"\n', { mode: 0o700 });
  const r = run('bash', f.args.filter((x) => x !== '--no-system-deps'), { env: { ...f.env, M365_TEST_SUDO_LOG: log } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3); assert.equal(lines[0], '-v'); assert.equal(lines[1], 'apt-get update');
  assert.match(lines[2], /^apt-get install -y --no-install-recommends /);
  assert.match(lines[2], /libasound2t64/); assert.ok(!lines.join(' ').match(/(?:\bnode|\bnpm|\bpnpm|curl https)/));
});
test('missing apt library stops before any apt install (synthetic apt/sudo)', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t), log = join(f.dir, 'sudo-log');
  await writeFile(join(f.bin, 'sudo'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$M365_TEST_SUDO_LOG"\nexit 0\n', { mode: 0o700 });
  await writeFile(join(f.bin, 'apt-cache'), '#!/bin/sh\nprintf "Candidate: (none)\\n"\n', { mode: 0o700 });
  const r = run('bash', f.args.filter((x) => x !== '--no-system-deps'), { env: { ...f.env, M365_TEST_SUDO_LOG: log } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /no apt candidate/);
  assert.ok(!(await readFile(log, 'utf8')).includes('apt-get install'));
});

test('installer automatically recovers a legacy dead PID lock and keeps account data', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.env.M365_LOCAL_STATE_DIR, 'browser-profile'), { recursive: true });
  await writeFile(join(f.env.M365_LOCAL_STATE_DIR, 'api-key'), 'KEEP_KEY');
  await writeFile(join(f.env.M365_LOCAL_STATE_DIR, 'process.lock'), JSON.stringify({ pid: 2147483647, created: 'legacy' }));
  const result = run('bash', f.args, { env: f.env });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stderr, /Recovered stale process.lock/);
  await assert.rejects(stat(join(f.env.M365_LOCAL_STATE_DIR, 'process.lock')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.env.M365_LOCAL_STATE_DIR, 'api-key'), 'utf8'), 'KEEP_KEY');
});
test('installer holds the same state guard during build so a competing proxy cannot start', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.src, 'scripts/bootstrap.mjs'), `import {acquireLock} from '../src/util.mjs';
try { const r=await acquireLock(process.env.M365_LOCAL_STATE_DIR); await r(); process.exit(52); }
catch(e) { if(e.code!=='profile_locked')throw e; console.log('STATE_GUARD_VERIFIED'); }\n`);
  const result = run('bash', f.args, { env: f.env });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /STATE_GUARD_VERIFIED/);
  await assert.rejects(stat(join(f.env.M365_LOCAL_STATE_DIR, 'process.lock')), { code: 'ENOENT' });
});
test('failed installer build releases its process lock for the next attempt', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t);
  const result = run('bash', f.args, { env: { ...f.env, M365_TEST_BUILD_FAIL: '1' } });
  assert.notEqual(result.status, 0);
  await assert.rejects(stat(join(f.env.M365_LOCAL_STATE_DIR, 'process.lock')), { code: 'ENOENT' });
  const retry = run('bash', f.args, { env: f.env }); assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});

// The optional short command must never replace an unrelated executable.
test('optional m365prox alias preserves an existing unrelated command', { skip: !ordinaryUser }, async (t) => {
  const f = await fixture(t); await mkdir(f.commandDir); await writeFile(join(f.commandDir, 'm365prox'), 'KEEP_SHORT_COMMAND');
  const result = run('bash', f.args, { env: f.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(f.commandDir, 'm365prox'), 'utf8'), 'KEEP_SHORT_COMMAND');
  assert.match(result.stderr, /unrelated m365prox/);
});
