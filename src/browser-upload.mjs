import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProxyError, invalid } from './errors.mjs';
import { abortable, detachCleanup } from './lifecycle.mjs';
import { uploadPayload, acceptsFile, COPILOT_FILES_PER_MESSAGE, uploadableSource } from './upload-manifest.mjs';
import { isChathub, SignalRFrames, BrowserTurnCollector, uploadEndpoint, uploadReceipt } from './browser-wire.mjs';

const CHAT = 'https://m365.cloud.microsoft/chat';
const UI_KEYS = ['composer', 'newChat', 'fileInput', 'attachButton', 'uploadMenu', 'attachment', 'sendButton'];
export async function loadUploadUI(path) {
  if (!path) return {};
  let raw;
  try { const text = await readFile(path, 'utf8'); if (Buffer.byteLength(text) > 8192) throw new Error(); raw = JSON.parse(text); }
  catch { throw invalid('Cannot read --upload-ui-config (JSON, maximum 8 KiB).'); }
  if (!raw || raw.version !== 1 || typeof raw.selectors !== 'object' || !raw.selectors || Array.isArray(raw.selectors) ||
      Object.keys(raw).some((k) => !['version', 'selectors'].includes(k)) || Object.entries(raw.selectors).some(([k, v]) => !UI_KEYS.includes(k) || typeof v !== 'string' || !v.trim() || v.length > 1000))
    throw invalid('Upload UI config requires version:1 and selectors containing only the documented locator keys.');
  return raw.selectors;
}
function sameSite(page) {
  let u; try { u = new URL(page.url()); } catch {}
  if (!u || u.protocol !== 'https:' || u.hostname !== 'm365.cloud.microsoft')
    throw new ProxyError(428, 'upload_browser_login_required', 'The temporary upload tab did not reach Microsoft 365 Copilot. Complete login in the main dedicated tab and retry; no file was attached.');
}
async function visible(locator) {
  const count = Math.min(await locator.count(), 24); let result = null;
  for (let i = 0; i < count; i++) if (await locator.nth(i).isVisible()) {
    if (result) throw new ProxyError(422, 'upload_ui_ambiguous', 'More than one visible upload/composer control matches. Set a precise selector with --upload-ui-config.');
    result = locator.nth(i);
  }
  return result;
}
async function until(task, { signal, milliseconds = 20000, code = 'upload_ui_missing', message = 'The expected Copilot UI control did not appear. See docs/UPLOAD_GUIDED.md for --upload-ui-config.' } = {}) {
  const end = Date.now() + milliseconds;
  do {
    signal?.throwIfAborted(); const result = await abortable(task, signal);
    if (result) return result;
    if (Date.now() >= end) throw new ProxyError(422, code, message);
    await sleep(150, undefined, { signal });
  } while (true);
}
export const DEFAULT_ATTACH_NAME = /^(?:add content|add and manage sources|add sources|attach(?: files?)?|open|agregar contenido|agregar y administrar fuentes|anadir contenido|anadir y administrar fuentes|a\u00f1adir contenido|a\u00f1adir y administrar fuentes|adjuntar(?: archivos?)?)(?:\b|$)/i;
export const DEFAULT_UPLOAD_NAME = /^(?:upload (?:images? and )?files?|upload images? or files?|add images? or files?|browse my computer|cargar (?:im\u00e1genes y )?archivos?|subir (?:im\u00e1genes y )?archivos?|agregar (?:im\u00e1genes o )?archivos?|a\u00f1adir (?:im\u00e1genes o )?archivos?|desde (?:este |el )?(?:dispositivo|equipo))(?:\b|$)/i;

async function firstVisible(locator) {
  const count = Math.min(await locator.count(), 32);
  for (let i = 0; i < count; i++) if (await locator.nth(i).isVisible()) return locator.nth(i);
  return null;
}
async function waitMaybe(task, { signal, milliseconds = 2500 } = {}) {
  const end = Date.now() + milliseconds;
  do {
    signal?.throwIfAborted();
    try { const result = await abortable(task, signal); if (result) return result; } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (error instanceof ProxyError && error.code === 'upload_ui_ambiguous') throw error;
    }
    if (Date.now() >= end) return null;
    await sleep(125, undefined, { signal });
  } while (true);
}
function frameRoots(page) {
  const roots = [page];
  try {
    const main = page.mainFrame?.();
    for (const frame of page.frames?.() ?? []) if (frame !== main) roots.push(frame);
  } catch {}
  return roots;
}
async function byRoleAcross(page, roles, name) {
  for (const root of frameRoots(page)) {
    for (const role of roles) {
      try { const found = await firstVisible(root.getByRole(role, { name })); if (found) return found; } catch {}
    }
  }
  return null;
}
async function bySafeAttributes(page, terms) {
  const selector = 'button, [role="button"], [role="menuitem"], [role="option"], a';
  for (const root of frameRoots(page)) {
    let all; try { all = root.locator(selector); } catch { continue; }
    const n = Math.min(await all.count().catch(() => 0), 64);
    for (let i = 0; i < n; i++) {
      const item = all.nth(i);
      if (!await item.isVisible().catch(() => false)) continue;
      const values = [];
      for (const attr of ['aria-label', 'title', 'data-testid', 'name']) values.push((await item.getAttribute(attr).catch(() => '')) ?? '');
      const text = await item.innerText().catch(() => '');
      values.push(String(text).slice(0, 160));
      const haystack = values.join(' ').replace(/\s+/g, ' ').trim();
      if (haystack && terms.test(haystack)) return item;
    }
  }
  return null;
}
function chooserAdapter(chooser) {
  return {
    getAttribute: async (name) => chooser.element().getAttribute(name),
    setInputFiles: (files, options) => chooser.setFiles(files, options),
  };
}

export class NativeBrowserUI {
  constructor(selectors = {}) { this.selectors = selectors; }
  async composer(page, signal) {
    return until(async () => {
      sameSite(page);
      if (this.selectors.composer) return visible(page.locator(this.selectors.composer));
      for (const root of frameRoots(page)) {
        for (const spec of ['[role="textbox"][contenteditable="true"]', '[contenteditable="true"][aria-label*="Copilot"]', 'textarea']) {
          try { const loc = await firstVisible(root.locator(spec)); if (loc) return loc; } catch {}
        }
      }
      return null;
    }, { signal });
  }
  async fresh(page, signal) {
    // Navigating to /chat is the least UI-dependent way to obtain a fresh surface.
    // Current Copilot builds create a fresh conversation state from this route; the
    // known working browser driver used by the reference implementation does the
    // same. A custom newChat selector remains available for tenants that require it.
    await abortable(() => page.goto(CHAT, { waitUntil: 'domcontentloaded', timeout: 30000 }), signal);
    await this.composer(page, signal);
    if (this.selectors.newChat) {
      const button = await until(() => visible(page.locator(this.selectors.newChat)), {
        signal, milliseconds: 12000, code: 'upload_new_chat_missing',
        message: 'Configured selectors.newChat did not match a visible control.'
      });
      signal.throwIfAborted(); await abortable(() => button.click({ timeout: 5000 }), signal);
      await this.composer(page, signal);
    }
    // The file input is frequently injected after the composer. Give the page a
    // short event-loop window before the picker begins its own bounded probing.
    await abortable(() => page.waitForTimeout?.(600) ?? sleep(600), signal);
  }
  async input(page, file) {
    const selector = this.selectors.fileInput ?? 'input[type="file"]';
    const candidates = [];
    for (const root of frameRoots(page)) {
      let all; try { all = root.locator(selector); } catch { continue; }
      const n = await all.count().catch(() => 0);
      if (n > 24) throw new ProxyError(422, 'upload_ui_ambiguous', 'Too many file inputs. Configure selectors.fileInput.');
      for (let i = 0; i < n; i++) {
        const candidate = all.nth(i);
        const accept = await candidate.getAttribute('accept').catch(() => null);
        if (this.selectors.fileInput || !file || acceptsFile(accept, file)) candidates.push(candidate);
      }
    }
    if (candidates.length > 1) throw new ProxyError(422, 'upload_ui_ambiguous', 'Multiple document file inputs match. Set selectors.fileInput to a precise document input.');
    return candidates[0] ?? null;
  }
  async attachControl(page) {
    if (this.selectors.attachButton) return visible(page.locator(this.selectors.attachButton));
    return await byRoleAcross(page, ['button', 'link'], DEFAULT_ATTACH_NAME) ??
      await bySafeAttributes(page, /(?:add (?:and manage )?(?:content|sources)|attach|upload|source|file|plus|agregar|a\u00f1adir|adjuntar|subir|cargar|fuentes?)/i);
  }
  async uploadControl(page) {
    if (this.selectors.uploadMenu) return visible(page.locator(this.selectors.uploadMenu));
    return await byRoleAcross(page, ['menuitem', 'button', 'option', 'link'], DEFAULT_UPLOAD_NAME) ??
      await bySafeAttributes(page, /(?:upload (?:images? and )?files?|upload images? or files?|browse my computer|subir (?:im\u00e1genes y )?archivos?|cargar (?:im\u00e1genes y )?archivos?)/i);
  }
  async picker(page, signal, file) {
    sameSite(page);
    // Proven Copilot builds expose input[type=file] directly, but it may be
    // injected shortly after the composer. Wait briefly instead of failing on
    // the first DOM snapshot.
    let input = await waitMaybe(() => this.input(page, file), { signal, milliseconds: 3000 });
    if (input) return input;

    const attach = await waitMaybe(() => this.attachControl(page), { signal, milliseconds: 3000 });
    if (!attach) throw new ProxyError(422, 'upload_input_missing',
      'Copilot has no recognized file uploader. The proxy looked for a delayed input[type=file] and the current Add content / Add and manage sources controls. Check tenant upload policy or configure --upload-ui-config. Nothing was uploaded.');

    let chosen = null;
    const listener = (chooser) => { chosen = chooser; };
    page.on('filechooser', listener);
    try {
      signal.throwIfAborted(); await abortable(() => attach.click({ timeout: 5000 }), signal);
      // Some Copilot builds open the OS chooser directly, others reveal a menu,
      // and others insert the hidden file input only after the '+' button.
      input = await waitMaybe(async () => {
        if (chosen) return chooserAdapter(chosen);
        return this.input(page, file);
      }, { signal, milliseconds: 1500 });
      if (input) return input;

      const menu = await waitMaybe(() => this.uploadControl(page), { signal, milliseconds: 3000 });
      if (menu) {
        signal.throwIfAborted(); await abortable(() => menu.click({ timeout: 5000 }), signal);
      }
      return await until(async () => {
        if (chosen) return chooserAdapter(chosen);
        return this.input(page, file);
      }, {
        signal, milliseconds: 7000, code: 'upload_input_missing',
        message: 'Copilot opened the add-content flow but no Upload images and files chooser/input appeared. Check tenant policy or set selectors.attachButton/uploadMenu/fileInput in --upload-ui-config. Nothing was uploaded.'
      });
    } finally { page.off('filechooser', listener); }
  }
  async fill(page, text, signal) {
    const box = await this.composer(page, signal);
    signal.throwIfAborted(); await abortable(() => box.fill(text, { timeout: 10000 }), signal);
  }
  async attachmentReady(page, name) {
    const selector = this.selectors.attachment ?? '[data-testid*="attachment" i], [data-testid*="file-card" i], [data-testid*="filecard" i], [class*="attachment" i]';
    const chips = page.locator(selector).filter({ hasText: name });
    for (let i = 0; i < Math.min(await chips.count(), 30); i++) {
      const chip = chips.nth(i); if (!await chip.isVisible()) continue;
      if (await chip.getAttribute('aria-busy') === 'true' || await chip.locator('[role="progressbar"], [aria-busy="true"]').count()) continue;
      const text = (await chip.innerText()).slice(0, 5000).replaceAll(name, '');
      if (/upload failed|unsupported|could not upload|no se pudo|no compatible|error al (?:cargar|subir)/i.test(text))
        throw new ProxyError(422, 'upload_rejected', 'The browser reports that a selected file was rejected. No prompt was sent.');
      if (/uploading|processing|cargando|subiendo|procesando/i.test(text)) continue;
      return true;
    }
    return false;
  }
  async send(page, signal) {
    sameSite(page);
    const button = await until(async () => {
      const candidate = this.selectors.sendButton ? await visible(page.locator(this.selectors.sendButton)) :
        await byRoleAcross(page, ['button'], /^(?:send(?: message| prompt)?|submit|enviar(?: mensaje|solicitud)?)(?:\b|$)/i);
      return candidate && await candidate.isEnabled() ? candidate : null;
    }, { signal, milliseconds: 15000, code: 'upload_send_not_ready', message: 'Copilot did not enable the Send control after upload. Check attachment processing or selectors.sendButton. The proxy did not press Enter as a fallback.' });
    signal.throwIfAborted(); await abortable(() => button.click({ timeout: 5000 }), signal);
  }
}

class BrowserUploadSession {
  constructor(owner) {
    this.owner = owner;
    this.page = null;
    this.pageSubscriptions = [];
    this.socketSubscriptions = [];
    this.watchedSockets = new WeakSet();
    this.turn = null;
    this.attachments = new Map();
    this.closed = false;
    this.primaryPage = false;
    owner.sessions.add(this);
  }
  reusable() { return !this.closed && Boolean(this.page) && !this.page.isClosed?.(); }
  subscribe(bucket, emitter, event, fn) {
    emitter.on(event, fn); bucket.push(() => emitter.off(event, fn));
  }
  bindSocket(ws) {
    if (!isChathub(ws.url()) || this.watchedSockets.has(ws)) return;
    this.watchedSockets.add(ws);
    const tx = new SignalRFrames(), rx = new SignalRFrames();
    this.subscribe(this.socketSubscriptions, ws, 'framesent', ({ payload }) => {
      const turn = this.turn; if (!turn || turn.signal.aborted) return;
      try { for (const frame of tx.feed(payload)) turn.collector.sent(frame, ws); } catch (e) { turn.fail(e); }
    });
    this.subscribe(this.socketSubscriptions, ws, 'framereceived', ({ payload }) => {
      const turn = this.turn; if (!turn || turn.signal.aborted) return;
      try { for (const frame of rx.feed(payload)) turn.collector.received(frame, ws); } catch (e) { turn.fail(e); }
    });
    this.subscribe(this.socketSubscriptions, ws, 'close', () => {
      const turn = this.turn;
      if (turn?.collector.bound?.socket === ws && !turn.collector.done) turn.fail(new ProxyError(502, 'browser_incomplete_turn', 'The owned Chathub socket closed before a final answer.'));
    });
    this.subscribe(this.socketSubscriptions, ws, 'socketerror', () => {
      const turn = this.turn;
      if (turn?.collector.bound?.socket === ws) turn.fail(new ProxyError(502, 'browser_socket_error', 'The owned browser socket failed. No raw credential-bearing URL is exposed.'));
    });
  }
  bindPage(page) {
    this.subscribe(this.pageSubscriptions, page, 'close', () => {
      const turn = this.turn;
      this.page = null;
      if (turn && !turn.signal.aborted) turn.fail(new ProxyError(502, 'upload_tab_closed', 'The persistent Copilot conversation tab closed before its turn completed.'));
    });
    this.subscribe(this.pageSubscriptions, page, 'websocket', (ws) => this.bindSocket(ws));
    // The initial authentication tab can already have Chathub open by the time
    // upload mode claims it. BrowserSessionAuth retains only socket handles, not
    // frame contents, so we can attach passive observers without opening a tab.
    for (const ws of this.owner.auth.chathubSockets?.(page) ?? []) this.bindSocket(ws);
    this.subscribe(this.pageSubscriptions, page, 'response', (response) => {
      const turn = this.turn;
      if (!turn || turn.signal.aborted || !uploadEndpoint(response.url())) return;
      void (async () => {
        const length = Number(response.headers()['content-length'] ?? 0);
        if (length > 262144) return;
        const data = await response.json().catch(() => null);
        if (turn.signal.aborted || this.turn !== turn) return;
        const receipt = uploadReceipt(data, turn.expected);
        if (receipt) turn.receipts.set(receipt.name, receipt);
        if (/\/m365copilot\/uploadfile/i.test(new URL(response.url()).pathname) &&
            (response.status() >= 400 || data?.error || (data?.result?.value && !/^success$/i.test(data.result.value))))
          turn.fail(new ProxyError(response.status() === 429 ? 429 : 422, 'upload_rejected', 'Microsoft rejected the upload. Check format, size, quota and tenant policy. Partial uploaded copies may remain; no automatic retry.'));
      })().catch((e) => turn.fail(e instanceof ProxyError ? e : new ProxyError(502, 'upload_receipt_error', 'Could not verify the browser upload receipt.')));
    });
  }
  async ensurePage(signal, onPhase) {
    if (this.reusable()) {
      onPhase('reusing_upload_chat');
      sameSite(this.page);
      await this.owner.ui.composer(this.page, signal);
      return true;
    }
    const context = this.owner.auth.context;
    if (!context) throw new ProxyError(428, 'browser_closed', 'The dedicated authentication browser must remain open for upload mode.');

    // First reusable browser conversation claims the exact tab opened by auth.
    // This is the tab where the user signed in / optionally sent the short token
    // capture message. Do not navigate it to a fresh chat merely to start upload.
    const primary = this.owner.claimPrimaryPage(this);
    if (primary) {
      onPhase(primary.needsFresh ? 'resetting_initial_chat' : 'claiming_initial_chat');
      this.primaryPage = true;
      this.page = primary.page;
      this.bindPage(this.page);
      if (primary.needsFresh) await abortable(() => this.owner.ui.fresh(this.page, signal), signal);
      else await this.owner.ui.composer(this.page, signal);
      return false;
    }

    // A second genuinely independent local conversation can still get its own
    // tab. Normal reuse should stay on the initial tab, so this path is not hit
    // once sticky browser-session fallback has selected the existing session.
    onPhase('opening_upload_tab');
    const page = await abortable(() => context.newPage(), signal, (late) => detachCleanup(() => late.close()));
    this.page = page; this.bindPage(page);
    await abortable(() => this.owner.ui.fresh(page, signal), signal);
    return false;
  }
  async executeTurn({ files, prompt, signal, fail, onPhase, onText, phasePrefix = '', uploadDeadline }) {
    const expected = new Set(files.map((f) => f.name));
    const receipts = new Map(), uiReady = new Set();
    const marker = `LOCAL_PROXY_TURN_${randomUUID().replaceAll('-', '')}`;
    const collector = new BrowserTurnCollector(marker, { onText, maxChars: this.owner.config.maxOutputChars ?? 1048576 });
    const turn = { collector, expected, receipts, signal, fail };
    this.turn = turn;
    let timer;
    try {
      if (files.length) {
        timer = setTimeout(() => fail(new ProxyError(504, 'upload_timeout', 'A Copilot attachment batch exceeded its deadline. Uploaded copies may remain in Microsoft storage; no prompt fallback or automatic replay was made.')), uploadDeadline);
        onPhase(phasePrefix ? `${phasePrefix}_locating_uploader` : 'locating_uploader');
      }
      for (const file of files) {
        const picker = await abortable(() => this.owner.ui.picker(this.page, signal, file), signal);
        onPhase(phasePrefix ? `${phasePrefix}_uploading_files` : 'uploading_files');
        const accept = await abortable(() => picker.getAttribute('accept'), signal);
        if (!acceptsFile(accept, file)) throw new ProxyError(422, 'upload_format_not_accepted', 'The native file input does not accept a selected extension. No extension was disguised. Narrow .m365ignore, use read mode, or select the correct document input.');
        signal.throwIfAborted();
        await abortable(() => picker.setInputFiles(file, { timeout: 15000 }), signal);
        await until(async () => {
          if (await this.owner.ui.attachmentReady(this.page, file.name)) { uiReady.add(file.name); return true; }
          return receipts.has(file.name);
        }, { signal, milliseconds: uploadDeadline, code: 'upload_unconfirmed', message: 'No successful upload receipt or ready attachment card was observed. Configure selectors.attachment for this UI. No prompt fallback was used.' });
      }
      for (const file of files) {
        const card = await this.owner.ui.attachmentReady(this.page, file.name);
        if (card) uiReady.add(file.name);
        if (!card && !receipts.get(file.name)?.conversationId)
          throw new ProxyError(422, 'upload_attachment_missing', 'An uploaded file is no longer present in the composer and has no conversation-bound receipt. No prompt was sent.');
      }
      collector.setReceipts(receipts.values());
      await abortable(() => this.owner.ui.fill(this.page, marker + '\n' + prompt, signal), signal);
      clearTimeout(timer);
      onPhase(phasePrefix ? `${phasePrefix}_sending_prompt` : 'sending_browser_prompt');
      signal.throwIfAborted();
      await abortable(() => this.owner.ui.send(this.page, signal), signal);
      onPhase(phasePrefix ? `${phasePrefix}_waiting_answer` : 'waiting_browser_answer');
      await until(() => collector.done, { signal, milliseconds: this.owner.config.requestTimeoutMs ?? 240000,
        code: 'browser_completion_timeout', message: 'No correlated final Chathub answer arrived. The remote turn was not replayed.' });
      signal.throwIfAborted();
      return { text: collector.text, receipts, uiReady, conversationId: collector.bound?.conversationId ?? null };
    } finally {
      clearTimeout(timer);
      if (this.turn === turn) this.turn = null;
    }
  }
  async run({ snapshot, prompt, signal, reused = false, onPhase = () => {}, onText = () => {} }) {
    if (this.closed) throw new ProxyError(503, 'upload_session_closed', 'The browser conversation session is closed. Retry so the proxy can create a new conversation.');
    if (this.owner.cleanupBlocked) throw new ProxyError(503, 'upload_cleanup_required', 'A previous owned browser tab could not close. Restart the proxy before another upload.');
    if (this.owner.activeSession && this.owner.activeSession !== this) throw new ProxyError(429, 'upload_busy', 'Another browser-owned upload is active.');
    if (this.turn) throw new ProxyError(429, 'upload_busy', 'This browser conversation is already processing a turn.');
    this.owner.activeSession = this;

    const selected = snapshot.selected ?? [];
    if (!selected.length && !snapshot.allowEmpty) throw new ProxyError(422, 'workspace_empty', 'No selected source files to upload.');
    // Copilot web rejects zero-byte attachments. Keep those files in the
    // workspace manifest as authoritative empty local files, but never feed them
    // to the native uploader. If they later gain content their hash/size changes
    // and they become uploadable automatically on the next turn.
    const metadataOnlySource = selected.filter((f) => !uploadableSource(f));
    const uploadable = selected.filter(uploadableSource);
    const changedSource = uploadable.filter((f) => this.attachments.get(f.path) !== f.sha256);
    const cachedSource = uploadable.filter((f) => this.attachments.get(f.path) === f.sha256);
    const files = changedSource.map((source) => ({ ...uploadPayload(source), sourcePath: source.path, sourceSha256: source.sha256 }));
    const batches = [];
    for (let i = 0; i < files.length; i += COPILOT_FILES_PER_MESSAGE) batches.push(files.slice(i, i + COPILOT_FILES_PER_MESSAGE));
    if (!batches.length) batches.push([]);

    const abort = new AbortController();
    const relay = () => abort.abort(signal.reason);
    signal?.addEventListener('abort', relay, { once: true }); if (signal?.aborted) relay();
    const localSignal = abort.signal;
    const fail = (error) => { if (!localSignal.aborted) abort.abort(error); };
    let result, pageWasReusable = false, allReceipts = 0, allUiReady = 0, sentBatches = 0;
    const uploadDeadline = this.owner.config.uploadTimeoutMs ?? 90000;
    try {
      pageWasReusable = await this.ensurePage(localSignal, onPhase);
      if (reused && !pageWasReusable) throw new ProxyError(409, 'browser_conversation_lost', 'The remote Copilot conversation page was lost. Retry once; the proxy will reconstruct a new conversation from the client history rather than sending only the latest turn.');

      const reuseNotice = reused ?
        `REMOTE COPILOT CONVERSATION REUSED. This request continues the same local client session.\n` +
        `The CURRENT workspace manifest below is authoritative for this turn. Ignore older versions of project attachments when a newer hash/name is listed. ` +
        `${cachedSource.length} selected attachment(s) were already uploaded unchanged in this same conversation; ${files.length} are new or changed in this turn.\n` : '';

      // Copilot web accepts at most three files in one message. When more current
      // files need uploading, prime the SAME chat with hidden context-sync turns
      // of <=3 attachments, then send the real user request with the final batch.
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const final = i === batches.length - 1;
        const batchNo = i + 1;
        let turnPrompt;
        if (final) turnPrompt = reuseNotice + prompt;
        else turnPrompt =
          `LOCAL WORKSPACE CONTEXT SYNC ${batchNo}/${batches.length}.\n` +
          `These ${batch.length} attachment(s) are current local workspace source for the NEXT user request in this same conversation. ` +
          `Do not modify files, do not execute actions, and do not answer the pending user task yet. Reply briefly that the context batch is received.`;
        const prefix = final ? '' : `context_batch_${batchNo}`;
        const turn = await this.executeTurn({ files: batch, prompt: turnPrompt, signal: localSignal, fail, onPhase, onText, phasePrefix: prefix, uploadDeadline });
        sentBatches++;
        allReceipts += turn.receipts.size; allUiReady += turn.uiReady.size;
        for (const file of batch) this.attachments.set(file.sourcePath, file.sourceSha256);
        if (final) result = turn;
      }

      // Cached selections were already uploaded in this persistent conversation.
      for (const source of cachedSource) this.attachments.set(source.path, source.sha256);
      return { text: result.text, metadata: { transport: 'browser_persistent_conversation', uploaded_files: files.length > 0,
        attached_files: files.length, selected_files: selected.length, metadata_only_files: metadataOnlySource.length, cached_attachments: cachedSource.length,
        uploaded_bytes: files.reduce((n, f) => n + f.buffer.length, 0), receipt_confirmed_files: allReceipts, ui_confirmed_files: allUiReady,
        same_page_turn: true, persistent_chat: true, initial_auth_tab: this.primaryPage,
        remote_conversation_reused: Boolean(reused && pageWasReusable),
        conversation_id_checked: Boolean(result.conversationId), cache_reused: cachedSource.length > 0,
        upload_messages: files.length ? sentBatches : 0, browser_messages: sentBatches, context_sync_messages: files.length ? Math.max(0, sentBatches - 1) : 0, files_per_message_limit: COPILOT_FILES_PER_MESSAGE,
        remote_deleted: false, model_selection: 'copilot_web_default', output_buffered: true } };
    } catch (error) {
      if (localSignal.aborted) throw localSignal.reason;
      if (error instanceof ProxyError) throw error;
      throw new ProxyError(502, 'browser_turn_failed', 'The persistent browser turn failed. No automatic replay was made. The conversation will be discarded before the next attempt.');
    } finally {
      signal?.removeEventListener('abort', relay);
      if (!localSignal.aborted) abort.abort(new DOMException('Turn finished.', 'AbortError'));
      this.turn = null; this.owner.activeSession = null;
      for (const file of files) file.buffer.fill(0);
    }
  }
  async reset() {
    if (this.closed) return;
    this.closed = true;
    const page = this.page; this.page = null;
    const turn = this.turn;
    if (turn && !turn.signal.aborted) turn.fail(new DOMException('Conversation closed.', 'AbortError'));
    this.turn = null;
    for (const off of [...this.pageSubscriptions, ...this.socketSubscriptions]) { try { off(); } catch {} }
    this.pageSubscriptions = []; this.socketSubscriptions = [];
    this.attachments.clear(); this.owner.sessions.delete(this);
    if (this.primaryPage) {
      this.owner.releasePrimaryPage(this);
      this.primaryPage = false;
      return;
    }
    if (page && !page.isClosed?.()) {
      try { await abortable(() => page.close({ runBeforeUnload: false }), AbortSignal.timeout(this.owner.closeTimeoutMs)); }
      catch { this.owner.cleanupBlocked = !page.isClosed?.(); }
    }
  }
}

export class BrowserUploadTransport {
  constructor({ auth, config, ui = new NativeBrowserUI(), closeTimeoutMs = 2500 }) {
    this.auth = auth; this.config = config; this.ui = ui; this.closeTimeoutMs = closeTimeoutMs;
    this.sessions = new Set(); this.activeSession = null; this.cleanupBlocked = false;
    this.primaryOwner = null; this.primaryNeedsFresh = false;
  }
  claimPrimaryPage(session) {
    const page = this.auth.page;
    if (!page || page.isClosed?.() || (this.primaryOwner && this.primaryOwner !== session)) return null;
    this.primaryOwner = session;
    this.auth.pinPage?.(page);
    const needsFresh = this.primaryNeedsFresh; this.primaryNeedsFresh = false;
    return { page, needsFresh };
  }
  releasePrimaryPage(session) {
    if (this.primaryOwner !== session) return;
    this.primaryOwner = null;
    this.auth.unpinPage?.(this.auth.page);
    // A different logical session must not inherit an uncertain/branched remote
    // conversation, but it can safely reuse the SAME browser tab after /chat reset.
    this.primaryNeedsFresh = true;
  }
  createSession() { return new BrowserUploadSession(this); }
  status() { return { enabled: true, transport: 'browser_persistent_conversation', experimental: true, cache: true,
    persistent_sessions: this.sessions.size, active_tab: Boolean(this.activeSession?.page), cleanup_blocked: this.cleanupBlocked,
    primary_auth_tab_claimed: Boolean(this.primaryOwner), files_per_message_limit: COPILOT_FILES_PER_MESSAGE,
    ui_profile: Boolean(this.config.uploadUiFile), conversation_mode: this.config.conversationMode ?? 'reuse' }; }
  // Backward-compatible one-shot API used by diagnostics/tests: creates one
  // ephemeral conversation and closes it after the turn. ProxyEngine uses
  // createSession() so normal client threads can reuse a single web chat.
  async run(args) {
    const session = this.createSession(); let result, error;
    try { result = await session.run({ ...args, reused: false }); }
    catch (e) { error = e; }
    finally { await session.reset(); }
    if (this.cleanupBlocked) throw new ProxyError(503, 'upload_cleanup_required', 'The owned tab could not close safely. Restart the proxy. No final successful reply was exposed.');
    if (error) throw error;
    return result;
  }
  // Compatibility with older diagnostics/tests that inspected activePage.
  get activePage() { return this.activeSession?.page ?? null; }
  set activePage(value) { this.activeSession = value ? { page: value } : null; }
  async close() {
    const sessions = [...this.sessions];
    await Promise.allSettled(sessions.map((session) => session.reset()));
  }
}
