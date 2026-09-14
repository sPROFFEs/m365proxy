import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getApiKey, acquireLock, safeEqual } from '../src/util.mjs';
import { readConfig } from '../src/config.mjs';

test('API key persists and is created with restrictive POSIX modes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-key-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await getApiKey(dir); assert.equal(key.length, 64); assert.equal(await getApiKey(dir), key);
  if (process.platform !== 'win32') { assert.equal((await stat(join(dir, 'api-key'))).mode & 0o777, 0o600); assert.equal((await stat(dir)).mode & 0o777, 0o700); }
});
test('profile lock prevents competing processes without stealing a stale lock', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-lock-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const release = await acquireLock(dir); await assert.rejects(acquireLock(dir), (e) => e.code === 'profile_locked');
  await release(); const release2 = await acquireLock(dir); await release2();
});
test('key equality does not accept prefixes', () => { assert.ok(safeEqual('abc', 'abc')); assert.ok(!safeEqual('abc', 'ab')); });
test('configuration never exposes a non-loopback bind option', () => {
  assert.equal(readConfig([], {}).host, '127.0.0.1'); assert.throws(() => readConfig(['--host', '0.0.0.0'], {}), /Unknown/);
});
test('configuration validates browser, tool mode and numeric bounds', () => {
  assert.throws(() => readConfig(['--port', 'NaN'], {})); assert.throws(() => readConfig(['--channel', 'random'], {}));
  assert.throws(() => readConfig(['--repair-attempts', '2'], {})); assert.equal(readConfig(['--channel', 'msedge'], {}).channel, 'msedge');
});
test('experimental execution requires an explicit workspace and stays separate from auto-write/patch', () => {
  assert.throws(() => readConfig(['--exec-mode', 'script'], {}), /workspace/i);
  const ok = readConfig(['--workspace', '.', '--exec-mode', 'script', '--context-policy', 'adaptive', '--exec-max-steps', '3', '--exec-timeout-ms', '5000'], {});
  assert.equal(ok.execMode, 'script'); assert.equal(ok.execMaxSteps, 3); assert.equal(ok.execTimeoutMs, 5000); assert.equal(ok.contextPolicy, 'adaptive');
  assert.throws(() => readConfig(['--workspace', '.', '--exec-mode', 'script', '--write-mode', 'auto'], {}), /OR experimental/i);
  assert.throws(() => readConfig(['--workspace', '.', '--exec-mode', 'script', '--context-mode', 'patch'], {}), /patch/i);
  assert.throws(() => readConfig(['--workspace', '.', '--context-policy', 'random'], {}), /context-policy/);
});
test('compatibility mode is default and strict mode can be selected explicitly', () => {
  assert.equal(readConfig([], {}).compatMode, true);
  assert.equal(readConfig(['--strict'], {}).compatMode, false);
  assert.equal(readConfig(['--compat'], { M365PROXY_STRICT: '1' }).compatMode, true);
  assert.equal(readConfig([], { M365PROXY_COMPAT_MODE: '0' }).compatMode, false);
  assert.throws(() => readConfig(['--strict', '--compat'], {}), /either/);
});
