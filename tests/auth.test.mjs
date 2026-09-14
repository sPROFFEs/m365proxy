import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSessionAuth, tokenFromChathubUrl } from '../src/auth.mjs';
import { jwtUrl } from './helpers.mjs';
const settings = { captureTimeoutMs: 100, channel: 'chromium', headless: false };

test('Chathub token is parsed without assuming local JWT signature validation', () => {
  const token = tokenFromChathubUrl(jwtUrl());
  assert.ok(token.token); assert.equal(token.identity.length, 64);
});
for (const override of [{ host: 'substrate.office.com.evil.invalid' }, { host: 'example.invalid' }, { host: 'substrate.office.com:8443' }, { protocol: 'http' }, { exp: 1 }]) test('reject unsupported token source ' + JSON.stringify(override), () => {
  assert.equal(tokenFromChathubUrl(jwtUrl(override)), null);
});
test('reject malformed JWT, wrong path and mismatched account path', () => {
  assert.equal(tokenFromChathubUrl('wss://substrate.office.com/m365Copilot/Chathub?access_token=x.y.z'), null);
  assert.equal(tokenFromChathubUrl(jwtUrl().replace('/m365Copilot/Chathub/', '/other/')), null);
  assert.equal(tokenFromChathubUrl(jwtUrl().replace('11111111-1111-1111-1111-111111111111@', '99999999-9999-9999-9999-999999999999@')), null);
});
test('status never includes credentials or account IDs', () => {
  const auth = new BrowserSessionAuth(settings); auth.capture(jwtUrl());
  const status = JSON.stringify(auth.status());
  assert.equal(auth.status().state, 'ready'); assert.ok(!status.includes('eyJ')); assert.ok(!status.includes('11111111'));
});
test('account changes invalidate state and remain latched until restart', () => {
  const auth = new BrowserSessionAuth(settings); auth.capture(jwtUrl());
  assert.equal(auth.capture(jwtUrl({ oid: '33333333-3333-3333-3333-333333333333' })), false);
  assert.equal(auth.status().state, 'account_changed'); assert.equal(auth.credential, null);
  assert.equal(auth.capture(jwtUrl()), false);
});
test('expired credentials become authentication_required', () => {
  let now = Date.now(); const auth = new BrowserSessionAuth(settings, { clock: () => now });
  auth.capture(jwtUrl({ exp: Math.floor(now / 1000) + 120 })); now += 90000;
  assert.equal(auth.status().state, 'authentication_required');
});
test('waiter timeout cleans listeners and asks for explicit browser interaction', async () => {
  const auth = new BrowserSessionAuth(settings); auth.context = {};
  await assert.rejects(auth.waitForCapture(5), (e) => e.code === 'authentication_required');
  assert.equal(auth.listenerCount('state'), 0);
});
test('waiter abort cleans listeners', async () => {
  const auth = new BrowserSessionAuth(settings); auth.context = {};
  const controller = new AbortController(); const waiting = auth.waitForCapture(1000, controller.signal);
  controller.abort(); await assert.rejects(waiting); assert.equal(auth.listenerCount('state'), 0);
});
test('persistent-browser bootstrap attaches websocket listener before navigating', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-auth-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const page = new EventEmitter();
  page.goto = async () => page.emit('websocket', { url: () => jwtUrl() });
  page.reload = page.goto;
  const context = new EventEmitter(); context.pages = () => [page]; context.close = async () => context.emit('close');
  let capturedOptions;
  const chromium = { launchPersistentContext: async (profile, opts) => { capturedOptions = { profile, opts }; return context; } };
  const auth = new BrowserSessionAuth({ ...settings, stateDir: dir }, { chromium });
  await auth.start(); assert.equal(auth.status().state, 'ready');
  assert.ok(capturedOptions.profile.endsWith('browser-profile')); assert.equal(capturedOptions.opts.headless, false);
  assert.ok(await auth.getToken()); await auth.close(); assert.equal(auth.credential, null);
});
test('simultaneous refresh waiters share a pending reload', async () => {
  const auth = new BrowserSessionAuth(settings); auth.context = {};
  let reloads = 0; let finish;
  auth.page = { reload: () => { reloads++; return new Promise((r) => { finish = r; }); } };
  const a = auth.getToken(); const b = auth.getToken();
  auth.capture(jwtUrl()); finish();
  assert.equal(await a, await b); assert.equal(reloads, 1);
});

test('closing during a delayed launch closes the late browser instead of retaining it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-late-browser-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let release, launched = false, closed = 0;
  const auth = new BrowserSessionAuth({ ...settings, stateDir: dir }, { chromium: {
    launchPersistentContext: () => { launched = true; return new Promise((r) => { release = r; }); },
  } });
  const pending = auth.start();
  while (!launched) await new Promise((r) => setTimeout(r, 1));
  await auth.close(); release({ close: async () => { closed++; } });
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.equal(auth.context, null); assert.equal(closed, 1);
});


test('background refresh never reloads a pinned persistent conversation page', async () => {
  let now = Date.now(), primaryReloads = 0, tempNavigations = 0, tempClosed = 0;
  const primary = { reload: async () => { primaryReloads++; }, isClosed: () => false };
  const temp = new EventEmitter();
  temp.isClosed = () => false;
  temp.close = async () => { tempClosed++; };
  const auth = new BrowserSessionAuth({ ...settings, captureTimeoutMs: 100 }, { clock: () => now });
  auth.context = { newPage: async () => temp };
  auth.page = primary;
  auth.capture(jwtUrl({ exp: Math.floor(now / 1000) + 90 }));
  auth.pinPage(primary);
  temp.goto = async () => {
    tempNavigations++;
    auth.capture(jwtUrl({ exp: Math.floor(now / 1000) + 900 }));
  };
  auth.refreshInBackground();
  while (auth.refreshPromise) await new Promise((r) => setTimeout(r, 1));
  assert.equal(primaryReloads, 0);
  assert.equal(tempNavigations, 1);
  assert.equal(tempClosed, 1);
  assert.equal(auth.status().state, 'ready');
});
