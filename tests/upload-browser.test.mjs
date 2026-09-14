// Synthetic UI/socket/receipt fixtures; no claim of live Microsoft coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserUploadTransport, loadUploadUI, NativeBrowserUI } from '../src/browser-upload.mjs';
import { sha256 } from '../src/util.mjs';
function file(path) { return { path, text: 'const a = 1;\n', bytes: 13, sha256: sha256('const a = 1;\n') }; }
const snapshot = { selected: [file('a.js'), file('b.js')] };
export function browserFixture(options = {}) {
  const page = new EventEmitter(), ws = new EventEmitter(); let closed = false, prompt = '', sends = 0, inputs = 0, newPages = 0, currentBatch = 0;
  const attached = new Set(), buffers = [], batchSizes = [];
  page.url = () => 'https://m365.cloud.microsoft/chat'; page.isClosed = () => closed;
  page.close = async () => { if (options.closeHangs) return new Promise(() => {}); closed = true; page.emit('close'); };
  ws.url = () => 'wss://substrate.office.com/m365Copilot/Chathub/u@t?ConversationId=conv&access_token=SENSITIVE';
  const emit = (name, data) => ws.emit(name, { payload: JSON.stringify(data) + '\x1e' });
  const ui = {
    fresh: async () => { if (options.freshHangs) return new Promise(() => {}); },
    composer: async () => ({}),
    picker: async () => ({ getAttribute: async () => options.accept ?? '', setInputFiles: async (f) => {
      inputs++; currentBatch++; buffers.push(f.buffer);
      if (options.uploadHangs) return new Promise(() => {});
      if (!options.noCard) attached.add(f.name);
      if (options.replace) { attached.clear(); attached.add(f.name); }
      if (options.receipt || options.badReceipt) page.emit('response', { url: () => 'https://substrate.office.com/m365Copilot/UploadFile', headers: () => ({}), status: () => options.badReceipt ? 400 : 200,
        json: async () => ({ fileName: f.name, docId: 'doc-' + f.name, conversationId: options.mismatch ? 'other' : 'conv', result: { value: options.badReceipt ? 'InvalidRequest' : 'Success' } }) });
    } }),
    attachmentReady: async (_page, name) => attached.has(name),
    fill: async (_page, text) => { prompt = text; if (options.cancelOnFill) options.cancelOnFill.abort(new DOMException('Cancel', 'AbortError')); },
    send: async () => {
      sends++; batchSizes.push(currentBatch); currentBatch = 0; page.emit('websocket', ws);
      emit('framesent', { type: 4, target: 'chat', invocationId: '0', arguments: [{ message: { author: 'user', text: prompt } }] });
      if (options.sendHangs) return new Promise(() => {});
      if (options.earlyClose) { ws.emit('close'); return; }
      emit('framereceived', { type: 1, invocationId: '0', arguments: [{ messages: [{ author: 'bot', text: 'O' }] }] });
      emit('framereceived', { type: 2, invocationId: '0', item: { result: { value: 'Success' }, messages: [{ author: 'bot', text: 'OK' }] } });
      attached.clear();
    },
  };
  const auth = { page: options.initialPage ? page : null, chathubSockets: () => options.existingSocket ? [ws] : [], context: { newPage: async () => { newPages++; return page; } } };
  const config = { uploadTimeoutMs: 1000, requestTimeoutMs: 2000, maxOutputChars: 1048576 };
  const transport = new BrowserUploadTransport({ auth, config, ui, closeTimeoutMs: 25 });
  return { transport, auth, config, page, ui, buffers, batchSizes, closed: () => closed, sent: () => sends, inputs: () => inputs, newPages: () => newPages };
}
const run = (f, extra = {}) => f.transport.run({ snapshot, prompt: 'Manifest then question', signal: AbortSignal.timeout(2500), ...extra });
test('uploads exact scanned buffers, sends in same page and closes the tab after correlated final', async () => {
  const f = browserFixture(), phases = [], text = [];
  const result = await run(f, { onPhase: (p) => phases.push(p), onText: (p) => text.push(p) });
  assert.equal(result.text, 'OK'); assert.equal(f.inputs(), 2); assert.equal(f.sent(), 1); assert.equal(f.closed(), true);
  assert.equal(result.metadata.attached_files, 2); assert.equal(result.metadata.output_buffered, true);
  assert.ok(phases.includes('uploading_files')); assert.deepEqual(text, ['O', 'K']);
  assert.ok(f.buffers.every((b) => b.every((byte) => byte === 0))); assert.equal(f.page.listenerCount('response'), 0);
});
test('conversation-bound receipts support uploads without recognizable DOM cards', async () => {
  const f = browserFixture({ receipt: true, noCard: true }); const result = await run(f);
  assert.equal(result.metadata.receipt_confirmed_files, 2); assert.equal(result.metadata.conversation_id_checked, true);
});
test('native accept prevents unsupported upload before any file or prompt is sent', async () => {
  const f = browserFixture({ accept: '.pdf' }); await assert.rejects(run(f), { code: 'upload_format_not_accepted' });
  assert.equal(f.inputs(), 0); assert.equal(f.sent(), 0); assert.equal(f.closed(), true);
});
test('rejected receipt fails closed without sending prompt, even if UI displays card', async () => {
  const f = browserFixture({ badReceipt: true }); await assert.rejects(run(f), { code: 'upload_rejected' }); assert.equal(f.sent(), 0);
});
test('sequential upload replacement is detected and not silently treated as two attachments', async () => {
  const f = browserFixture({ replace: true }); await assert.rejects(run(f), { code: 'upload_attachment_missing' }); assert.equal(f.sent(), 0);
});
test('receipt conversation mismatch rejects returned answer', async () => {
  const f = browserFixture({ receipt: true, mismatch: true }); await assert.rejects(run(f), { code: 'upload_conversation_mismatch' });
});
test('unconfirmed uploads time out instead of falling back to prompt contents', async () => {
  const f = browserFixture({ noCard: true }); f.config.uploadTimeoutMs = 25;
  await assert.rejects(run(f), { code: 'upload_timeout' }); assert.equal(f.sent(), 0);
});
test('hung input obeys cancellation and does not continue into send', async () => {
  const f = browserFixture({ uploadHangs: true }), controller = new AbortController();
  const pending = run(f, { signal: controller.signal }); setTimeout(() => controller.abort(new DOMException('Cancel', 'AbortError')), 25);
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(f.sent(), 0); assert.equal(f.closed(), true);
});
test('cancellation immediately before send suppresses the prompt', async () => {
  const c = new AbortController(), f = browserFixture({ cancelOnFill: c });
  await assert.rejects(run(f, { signal: c.signal }), { name: 'AbortError' }); assert.equal(f.sent(), 0);
});
test('socket close without final is a failure and never a fabricated completion', async () => {
  const f = browserFixture({ earlyClose: true }); await assert.rejects(run(f), { code: 'browser_incomplete_turn' }); assert.equal(f.closed(), true);
});
test('hung close blocks subsequent uploads and does not expose a successful response', async () => {
  const f = browserFixture({ closeHangs: true });
  const keepAlive = setTimeout(() => {}, 1500);
  try { await assert.rejects(run(f), { code: 'upload_cleanup_required' }); await assert.rejects(run(f), { code: 'upload_cleanup_required' }); }
  finally { clearTimeout(keepAlive); }
});
test('missing browser and concurrent calls fail explicitly', async () => {
  const f = browserFixture(); f.auth.context = null; await assert.rejects(run(f), { code: 'browser_closed' });
  const g = browserFixture(); g.transport.activePage = {}; await assert.rejects(run(g), { code: 'upload_busy' });
});




test('reuse claims the original authenticated Copilot tab instead of opening a new tab', async () => {
  const f = browserFixture({ initialPage: true, existingSocket: true });
  const session = f.transport.createSession();
  const first = await session.run({ snapshot, prompt: 'first', signal: AbortSignal.timeout(2500), reused: false });
  assert.equal(f.newPages(), 0); assert.equal(first.metadata.initial_auth_tab, true); assert.equal(f.closed(), false);
  const second = await session.run({ snapshot, prompt: 'second', signal: AbortSignal.timeout(2500), reused: true });
  assert.equal(f.newPages(), 0); assert.equal(second.metadata.remote_conversation_reused, true); assert.equal(f.sent(), 2);
  await session.reset();
  // Reset releases ownership but intentionally leaves the authentication tab alive.
  assert.equal(f.closed(), false);
});

test('more than three changed files are staged in <=3-file messages in the same chat', async () => {
  const f = browserFixture({ initialPage: true });
  const many = { selected: ['a.js','b.js','c.js','d.js','e.js'].map(file) };
  const session = f.transport.createSession();
  const result = await session.run({ snapshot: many, prompt: 'real user question', signal: AbortSignal.timeout(5000), reused: false });
  assert.equal(f.newPages(), 0);
  assert.deepEqual(f.batchSizes, [3, 2]);
  assert.equal(result.metadata.files_per_message_limit, 3);
  assert.equal(result.metadata.upload_messages, 2);
  assert.equal(result.metadata.context_sync_messages, 1);
  assert.equal(result.metadata.attached_files, 5);
  assert.equal(f.sent(), 2);
  await session.reset();
});
test('persistent browser session reuses one Copilot chat and skips unchanged attachments', async () => {
  const f = browserFixture(); const session = f.transport.createSession();
  const first = await session.run({ snapshot, prompt: 'first', signal: AbortSignal.timeout(2500), reused: false });
  assert.equal(first.metadata.remote_conversation_reused, false); assert.equal(first.metadata.cached_attachments, 0);
  assert.equal(f.inputs(), 2); assert.equal(f.sent(), 1); assert.equal(f.closed(), false);
  const second = await session.run({ snapshot, prompt: 'second', signal: AbortSignal.timeout(2500), reused: true });
  assert.equal(second.metadata.remote_conversation_reused, true); assert.equal(second.metadata.cached_attachments, 2);
  assert.equal(second.metadata.attached_files, 0); assert.equal(f.inputs(), 2); assert.equal(f.sent(), 2); assert.equal(f.closed(), false);
  await session.reset(); assert.equal(f.closed(), true);
});

test('persistent browser session reuploads only a changed selected file', async () => {
  const f = browserFixture(); const session = f.transport.createSession();
  await session.run({ snapshot, prompt: 'first', signal: AbortSignal.timeout(2500), reused: false });
  const changed = { selected: [file('a.js'), { ...file('b.js'), text: 'const a = 2;\n', bytes: 13, sha256: sha256('const a = 2;\n') }] };
  const second = await session.run({ snapshot: changed, prompt: 'second', signal: AbortSignal.timeout(2500), reused: true });
  assert.equal(second.metadata.attached_files, 1); assert.equal(second.metadata.cached_attachments, 1); assert.equal(f.inputs(), 3);
  await session.reset();
});
test('selectors config is bounded and cannot configure arbitrary target URLs or code', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'm365-ui-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ui.json'); await writeFile(path, JSON.stringify({ version: 1, selectors: { fileInput: '#docs' } }));
  assert.deepEqual(await loadUploadUI(path), { fileInput: '#docs' });
  for (const value of [{ version: 1, url: 'https://evil.test', selectors: {} }, { version: 1, selectors: { code: 'eval()' } }, { version: 1, selectors: { fileInput: 23 } }]) {
    await writeFile(path, JSON.stringify(value)); await assert.rejects(loadUploadUI(path), { code: 'invalid_request' });
  }
});
test('default UI refuses an off-site/login page before locating the composer', async () => {
  await assert.rejects(new NativeBrowserUI().composer({ url: () => 'https://login.microsoftonline.com/' }, new AbortController().signal), { code: 'upload_browser_login_required' });
});

test('default upload labels cover the current Microsoft add-sources wording', async () => {
  const { DEFAULT_ATTACH_NAME, DEFAULT_UPLOAD_NAME } = await import('../src/browser-upload.mjs');
  for (const label of ['Add content', 'Add and manage sources', 'Attach files']) assert.match(label, DEFAULT_ATTACH_NAME);
  for (const label of ['Upload images and files', 'Upload files', 'Browse my computer']) assert.match(label, DEFAULT_UPLOAD_NAME);
});

test('native picker waits for a delayed direct file input instead of failing on the first DOM snapshot', async () => {
  let ready = false;
  setTimeout(() => { ready = true; }, 20);
  const input = {
    isVisible: async () => false,
    getAttribute: async (name) => name === 'accept' ? '.py,.js' : null,
    setInputFiles: async () => {},
  };
  const none = { count: async () => 0, nth: () => { throw new Error('none'); } };
  const page = new EventEmitter();
  page.url = () => 'https://m365.cloud.microsoft/chat';
  page.mainFrame = () => page;
  page.frames = () => [page];
  page.locator = (selector) => {
    if (selector === 'input[type="file"]') return {
      count: async () => ready ? 1 : 0,
      nth: () => input,
    };
    return none;
  };
  page.getByRole = () => none;
  const picked = await new NativeBrowserUI().picker(page, AbortSignal.timeout(2000), { name: 'main.py', mimeType: 'text/plain' });
  assert.equal(picked, input);
});

test('native picker follows current Add and manage sources -> Upload images and files flow', async () => {
  let menuOpen = false, setFiles = 0;
  const none = { count: async () => 0, nth: () => { throw new Error('none'); } };
  const one = (item) => ({ count: async () => 1, nth: () => item });
  const attach = { isVisible: async () => true, click: async () => { menuOpen = true; } };
  const chooser = {
    element: () => ({ getAttribute: async (name) => name === 'accept' ? '.py,.js' : null }),
    setFiles: async () => { setFiles++; },
  };
  const page = new EventEmitter();
  page.url = () => 'https://m365.cloud.microsoft/chat';
  page.mainFrame = () => page;
  page.frames = () => [page];
  page.locator = () => none;
  page.getByRole = (role, { name } = {}) => {
    if (role === 'button' && name?.test?.('Add and manage sources')) return one(attach);
    if (menuOpen && role === 'menuitem' && name?.test?.('Upload images and files')) return one({
      isVisible: async () => true,
      click: async () => { queueMicrotask(() => page.emit('filechooser', chooser)); },
    });
    return none;
  };
  const picker = await new NativeBrowserUI().picker(page, AbortSignal.timeout(8000), { name: 'main.py', mimeType: 'text/plain' });
  assert.equal(await picker.getAttribute('accept'), '.py,.js');
  await picker.setInputFiles({ name: 'main.py', mimeType: 'text/plain', buffer: Buffer.from('x') });
  assert.equal(setFiles, 1);
});

test('fresh upload surface relies on /chat navigation and does not require a New chat button', async () => {
  let gotos = 0;
  const composerItem = { isVisible: async () => true };
  const none = { count: async () => 0, nth: () => { throw new Error('none'); } };
  const page = new EventEmitter();
  page.url = () => 'https://m365.cloud.microsoft/chat';
  page.mainFrame = () => page;
  page.frames = () => [page];
  page.goto = async (url) => { gotos++; assert.equal(url, 'https://m365.cloud.microsoft/chat'); };
  page.waitForTimeout = async () => {};
  page.locator = (selector) => selector === '[role="textbox"][contenteditable="true"]'
    ? { count: async () => 1, nth: () => composerItem }
    : none;
  page.getByRole = () => { throw new Error('fresh should not need a New chat role lookup'); };
  await new NativeBrowserUI().fresh(page, AbortSignal.timeout(2000));
  assert.equal(gotos, 1);
});

test('zero-byte selected files are described but never sent to the native uploader', async () => {
  const f = browserFixture({ initialPage: true });
  const empty = { path: 'README.md', text: '', bytes: 0, sha256: sha256('') };
  const session = f.transport.createSession();
  const result = await session.run({ snapshot: { selected: [empty], allowEmpty: true }, prompt: 'Explain the empty README metadata', signal: AbortSignal.timeout(2500), reused: false });
  assert.equal(f.inputs(), 0);
  assert.equal(f.sent(), 1);
  assert.equal(result.metadata.attached_files, 0);
  assert.equal(result.metadata.metadata_only_files, 1);
  assert.equal(result.metadata.upload_messages, 0);
  assert.equal(result.metadata.browser_messages, 1);
  await session.reset();
});

test('mixed empty and nonempty selection uploads only nonempty files', async () => {
  const f = browserFixture({ initialPage: true });
  const empty = { path: 'README.md', text: '', bytes: 0, sha256: sha256('') };
  const session = f.transport.createSession();
  const result = await session.run({ snapshot: { selected: [empty, file('a.js')] }, prompt: 'Use both workspace entries', signal: AbortSignal.timeout(2500), reused: false });
  assert.equal(f.inputs(), 1);
  assert.equal(f.sent(), 1);
  assert.equal(result.metadata.attached_files, 1);
  assert.equal(result.metadata.metadata_only_files, 1);
  assert.equal(result.metadata.upload_messages, 1);
  await session.reset();
});
