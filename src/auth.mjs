import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { privateDir, sha256 } from './util.mjs';
import { ProxyError } from './errors.mjs';
import { isChathub } from './browser-wire.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function tokenFromChathubUrl(raw, now = Date.now()) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  // Never follow a captured URL. Only consume credentials emitted to the exact
  // service host used by the pinned upstream transport.
  if (!['wss:', 'https:'].includes(url.protocol) || url.hostname !== 'substrate.office.com' || (url.port && url.port !== '443') || url.username || url.password || !/^\/m365copilot\/chathub(?:\/|$)/i.test(url.pathname)) return null;
  const token = url.searchParams.get('access_token');
  if (!token || token.length > 32000 || token.split('.').length !== 3) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!UUID.test(claims.oid ?? '') || !UUID.test(claims.tid ?? '') || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 60000) return null;
  const identityPath = decodeURIComponent(url.pathname).split('/').find((s) => s.includes('@'));
  if (identityPath && identityPath.toLowerCase() !== `${claims.oid}@${claims.tid}`.toLowerCase()) return null;
  // JWT claims are unverified metadata here, NOT authentication proof. Microsoft
  // validates the credential on the actual TLS connection.
  return { token, expiresAt: claims.exp * 1000, identity: sha256(`${claims.oid.toLowerCase()}:${claims.tid.toLowerCase()}`), capturedAt: now };
}

export class BrowserSessionAuth extends EventEmitter {
  constructor(options, { chromium, clock = Date.now } = {}) {
    super();
    this.options = options;
    this.chromium = chromium;
    this.clock = clock;
    this.credential = null;
    this.identity = null;
    this.context = null;
    this.page = null;
    this.refreshPromise = null;
    this.state = 'not_started';
    this.accountChanged = false;
    this.watched = new WeakSet();
    this.maintenance = null;
    this.refreshAttemptFor = null;
    this.refreshRetries = 0;
    this.lastRefreshFailedAt = null;
    this.stopping = false;
    this.lastChathubSeen = null;
    this.lastCaptureIssue = null;
    this.refreshAbort = null;
    // Keep handles for Chathub sockets opened by the primary authenticated tab.
    // Upload mode can then attach passive frame observers AFTER login without
    // forcing a navigation/new tab merely to observe a fresh websocket event.
    this.pageSockets = new WeakMap();
    this.pinnedPages = new WeakSet();
  }
  capture(rawUrl) {
    let candidate;
    try { candidate = tokenFromChathubUrl(rawUrl, this.clock()); } catch { return false; }
    if (!candidate) {
      try {
        const url = new URL(rawUrl);
        if (url.hostname === 'substrate.office.com' && /^\/m365copilot\/chathub(?:\/|$)/i.test(url.pathname)) {
          this.lastChathubSeen = new Date(this.clock()).toISOString();
          this.lastCaptureIssue = url.searchParams.has('access_token') ? 'unusable_token' : 'missing_access_token';
          this.emit('state');
        }
      } catch {}
      return false;
    }
    if (this.accountChanged || this.stopping) return false;
    this.lastChathubSeen = new Date(this.clock()).toISOString();
    this.lastCaptureIssue = null;
    if (this.identity && this.identity !== candidate.identity) {
      this.credential = null;
      this.accountChanged = true;
      this.state = 'account_changed';
      this.emit('state');
      return false;
    }
    this.identity = candidate.identity;
    if (this.credential && candidate.expiresAt < this.credential.expiresAt) return false;
    this.credential = candidate;
    this.refreshRetries = 0;
    this.lastRefreshFailedAt = null;
    this.state = 'ready';
    this.emit('state');
    return true;
  }
  status() {
    const valid = this.credential && this.credential.expiresAt > this.clock() + 60000;
    return { state: this.accountChanged ? 'account_changed' : valid ? 'ready' : this.state === 'ready' ? 'authentication_required' : this.state,
      expires_at: this.credential ? new Date(this.credential.expiresAt).toISOString() : null,
      browser_open: Boolean(this.context), token_storage: 'memory_only', auth_mode: 'browser_web_session',
      refreshing: Boolean(this.refreshPromise),
      last_chathub_seen_at: this.lastChathubSeen, last_capture_issue: this.lastCaptureIssue };
  }
  // HTTP inference never launches a browser, reloads a login page or waits for
  // MFA. A missing browser credential is a user-action error, not a retryable 5xx.
  getTokenNow() {
    if (this.accountChanged) throw new ProxyError(428, 'account_changed', 'The browser changed accounts. Restart the proxy before using this session.');
    if (this.credential && this.credential.expiresAt > this.clock() + 60000) return this.credential.token;
    throw new ProxyError(428, 'authentication_required',
      'Microsoft browser authentication is not ready. In the dedicated browser complete sign-in/MFA and send a short message in Copilot. Then retry. No prompt was sent to Microsoft.');
  }
  enableMaintenance({ isBusy = () => false, intervalMs = 2000 } = {}) {
    clearInterval(this.maintenance);
    this.maintenance = setInterval(() => {
      if (this.stopping || this.accountChanged || !this.context) return;
      if (this.state === 'ready' && this.status().state !== 'ready') {
        this.state = 'authentication_required'; this.emit('state');
      }
      // One warm reload per expiring credential, with at most one bounded backoff retry
      // on transient reload failures before hard expiration.
      if (!isBusy() && this.credential && this.credential.expiresAt <= this.clock() + 120000 && !this.refreshPromise) {
        const needsInitialRefresh = this.refreshAttemptFor !== this.credential.token;
        const canRetryTransient = this.refreshAttemptFor === this.credential.token && (this.refreshRetries ?? 0) < 1 &&
          this.credential.expiresAt > this.clock() + 70000 && this.lastRefreshFailedAt && (this.clock() - this.lastRefreshFailedAt >= 15000);
        if (needsInitialRefresh || canRetryTransient) {
          if (needsInitialRefresh) this.refreshRetries = 0;
          else this.refreshRetries = (this.refreshRetries ?? 0) + 1;
          this.refreshAttemptFor = this.credential.token;
          this.refreshInBackground();
        }
      }
    }, intervalMs);
    this.maintenance.unref?.();
  }
  refreshInBackground() {
    if (!this.page || this.refreshPromise || this.stopping) return;
    const previous = this.credential?.token;
    this.refreshAbort = new AbortController();
    this.state = 'refreshing';
    this.refreshPromise = (async () => {
      const waiting = this.waitForCapture(this.options.captureTimeoutMs ?? 45000, this.refreshAbort.signal, previous);
      waiting.catch(() => {});
      let refreshPage = this.page, temporary = null;
      try {
        // Upload reuse may own the initial authenticated tab as the persistent
        // conversation. Never reload that chat just to refresh a token. Use a
        // temporary authenticated page; it is closed after capture/timeout.
        if (this.pinnedPages.has(this.page) && this.context) {
          temporary = await this.context.newPage();
          refreshPage = temporary;
          this.watch(refreshPage);
          await refreshPage.goto('https://m365.cloud.microsoft/chat', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        } else {
          await refreshPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
        await waiting;
      } finally {
        if (temporary && !temporary.isClosed?.()) await temporary.close({ runBeforeUnload: false }).catch(() => {});
      }
    })().catch(() => {
      this.lastRefreshFailedAt = this.clock();
    }).finally(() => {
      this.refreshPromise = null; this.refreshAbort = null;
      if (!this.stopping && !this.accountChanged && this.context) {
        this.state = this.credential && this.credential.expiresAt > this.clock() + 60000 ? 'ready' : 'authentication_required';
        this.emit('state');
      }
    });
    this.emit('state');
  }
  pinPage(page) { if (page) this.pinnedPages.add(page); }
  unpinPage(page) { if (page) this.pinnedPages.delete(page); }
  watch(page) {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    const sockets = new Set();
    this.pageSockets.set(page, sockets);
    page.on('websocket', (ws) => {
      this.capture(ws.url());
      if (!isChathub(ws.url())) return;
      sockets.add(ws);
      const forget = () => sockets.delete(ws);
      ws.once?.('close', forget);
      ws.once?.('socketerror', forget);
      this.emit('chathub', { page, socket: ws });
    });
    // Do not inspect frame payloads here. BrowserUploadSession subscribes only
    // while it owns a turn and never persists/logs those payloads.
  }
  chathubSockets(page) {
    return [...(this.pageSockets.get(page) ?? [])];
  }
  async start() {
    if (this.context) return;
    if (!this.chromium) throw new ProxyError(503, 'browser_missing', 'Playwright is not installed. Run npm run setup.');
    const profile = join(this.options.stateDir, 'browser-profile');
    await privateDir(profile);
    this.state = 'opening_browser'; this.emit('state');
    try {
      const options = { headless: this.options.headless, timeout: 60000 };
      if (this.options.channel !== 'chromium') options.channel = this.options.channel;
      const context = await this.chromium.launchPersistentContext(profile, options);
      if (this.stopping) { await context.close().catch(() => {}); throw new DOMException('Stopped.', 'AbortError'); }
      this.context = context;
      this.context.on('page', (page) => this.watch(page));
      this.context.on('request', (request) => this.capture(request.url()));
      this.context.on('close', () => { this.context = null; this.page = null; this.credential = null; this.state = 'browser_closed'; this.emit('state'); });
      for (const page of this.context.pages()) this.watch(page);
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      this.watch(this.page);
      this.state = this.credential ? 'ready' : 'authentication_required'; this.emit('state');
      // Only normal navigation. Passwords/MFA are entered by the user.
      await this.page.goto('https://m365.cloud.microsoft/chat', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    } catch (error) {
      if (this.stopping) throw new DOMException('Stopped.', 'AbortError');
      this.state = 'browser_error'; this.emit('state');
      if (this.context) await this.close();
      throw new ProxyError(503, 'browser_start_failed', 'Cannot open the dedicated browser profile. Check the installed browser, display and profile lock; no security policy was bypassed.');
    }
  }
  waitForCapture(timeoutMs, signal, differentFrom) {
    const inspect = () => {
      if (this.accountChanged) throw new ProxyError(409, 'account_changed', 'The browser switched accounts. Restart the proxy to clear conversation state.');
      if (!this.context) throw new ProxyError(503, 'browser_closed', 'The authentication browser is closed. Restart the proxy.');
      if (this.credential && this.credential.token !== differentFrom && this.credential.expiresAt > this.clock() + 60000) return this.credential.token;
      return null;
    };
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); this.off('state', check); signal?.removeEventListener('abort', abort); };
      const check = () => { try { const token = inspect(); if (token) { cleanup(); resolve(token); } } catch (e) { cleanup(); reject(e); } };
      const abort = () => { cleanup(); reject(signal.reason); };
      this.on('state', check);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        cleanup(); this.state = 'authentication_required'; this.emit('state');
        reject(new ProxyError(503, 'authentication_required', 'Complete sign-in in the dedicated browser and send a short message in Copilot to open Chathub. Reload alone may not open it.'));
      }, timeoutMs);
      check();
    });
  }
  async getToken({ signal, timeoutMs = this.options.captureTimeoutMs, reload = true } = {}) {
    if (this.accountChanged) throw new ProxyError(409, 'account_changed', 'Account changed; restart the proxy.');
    if (signal?.aborted) throw signal.reason;
    if (this.credential && this.credential.expiresAt > this.clock() + 60000) return this.credential.token;
    if (!this.context) await this.start();
    // One reload shared by simultaneous callers. Each waiter has its own abort.
    if (reload && !this.refreshPromise && this.page) {
      this.state = 'refreshing';
      this.refreshPromise = this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}).finally(() => { this.refreshPromise = null; });
    }
    return this.waitForCapture(timeoutMs, signal);
  }
  invalidate() { this.credential = null; this.state = 'authentication_required'; this.emit('state'); }
  async close() {
    this.stopping = true;
    clearInterval(this.maintenance); this.maintenance = null;
    this.refreshAbort?.abort(new DOMException('Stopped.', 'AbortError'));
    this.refreshAttemptFor = null;
    const context = this.context;
    this.context = null; this.page = null; this.credential = null; this.state = 'browser_closed';
    this.emit('state');
    if (context) await context.close().catch(() => {});
  }
}
