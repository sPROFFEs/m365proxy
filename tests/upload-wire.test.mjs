import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalRFrames, BrowserTurnCollector, uploadReceipt, isChathub, uploadEndpoint } from '../src/browser-wire.mjs';
import { uploadPayload, attachmentName, acceptsFile, uploadManifest } from '../src/upload-manifest.mjs';
import { sha256 } from '../src/util.mjs';
const socket = (id = 'conversation-a') => ({ url: () => `wss://substrate.office.com/m365Copilot/Chathub/u@t?ConversationId=${id}&access_token=NEVER_LOG_THIS` });
const sent = (marker) => ({ type: 4, target: 'chat', invocationId: '0', arguments: [{ message: { author: 'user', text: marker } }] });
const part = (text, more = {}) => ({ type: 1, invocationId: '0', arguments: [{ messages: [{ author: 'bot', text, ...more }] }] });
const final = (text) => ({ type: 2, invocationId: '0', item: { result: { value: 'Success' }, messages: [{ author: 'bot', text }] } });
test('SignalR parsing handles split records and multiple records per frame', () => {
  const parser = new SignalRFrames(); assert.deepEqual(parser.feed('{"type":'), []);
  assert.deepEqual(parser.feed('6}\x1e{"type":3}\x1e'), [{ type: 6 }, { type: 3 }]);
});
test('SignalR malformed/oversized frames fail without raw payload', () => {
  assert.throws(() => new SignalRFrames().feed('TOKEN_BAD\x1e'), (e) => e.code === 'browser_protocol_changed' && !e.message.includes('TOKEN_BAD'));
  assert.throws(() => new SignalRFrames(4).feed('12345'), { code: 'browser_frame_limit' });
  // Test multibyte UTF-8 byte boundary
  assert.throws(() => new SignalRFrames(4).feed('€€'), { code: 'browser_frame_limit' }); // 2 euro symbols = 6 bytes in UTF-8
});
test('only the marker-correlated socket and invocation contribute text', () => {
  const ws = socket(), other = socket(); const c = new BrowserTurnCollector('nonce');
  c.received(part('before'), ws); assert.equal(c.text, '');
  c.sent(sent('other'), ws); assert.equal(c.bound, null);
  c.sent(sent('nonce'), ws); c.received(part('wrong socket'), other); c.received({ ...part('wrong invocation'), invocationId: '1' }, ws);
  c.received(part('right'), ws); assert.equal(c.text, 'right'); assert.equal(c.done, false);
  c.received(final('right final'), ws); assert.equal(c.done, true); assert.equal(c.text, 'right final');
});
test('collector can require both start and end markers before binding a browser turn', () => {
  const ws = socket();
  const c = new BrowserTurnCollector('LOCAL_PROXY_TURN_x', { endMarker: 'LOCAL_PROXY_END_x' });
  c.sent(sent('LOCAL_PROXY_TURN_x\npartial'), ws);
  assert.equal(c.bound, null);
  c.sent(sent('LOCAL_PROXY_TURN_x\ncomplete\nLOCAL_PROXY_END_x'), ws);
  assert.ok(c.bound);
});
test('cumulative text is not duplicated, and buffered final rewrites are accepted', () => {
  const ws = socket(), seen = []; const c = new BrowserTurnCollector('id', { onText: (text) => seen.push(text) });
  c.sent(sent('id'), ws); c.received(part('ab'), ws); c.received(part('abc'), ws); c.received(part('abc'), ws);
  c.received(final('corrected'), ws); assert.deepEqual(seen, ['ab', 'c', 'corrected']); assert.equal(c.text, 'corrected');
});
test('progress messages, user echo and reasoning are not response text', () => {
  const ws = socket(), c = new BrowserTurnCollector('id'); c.sent(sent('id'), ws);
  c.received(part('secret reasoning', { messageType: 'Progress' }), ws);
  c.received(part('user content', { author: 'user' }), ws);
  assert.equal(c.text, ''); c.received(final('OK'), ws); assert.equal(c.text, 'OK');
});
test('early close, refusal, quota and empty final are explicit failures', () => {
  for (const [frame, code] of [
    [{ type: 3, invocationId: '0' }, 'browser_incomplete_turn'],
    [part('blocked', { messageType: 'Disengaged' }), 'copilot_refusal'],
    [{ type: 2, item: { result: { value: 'Throttled' } } }, 'copilot_throttled'],
    [final(''), 'empty_response'],
    [{ type: 3, error: 'DO NOT EXPOSE TOKEN' }, 'copilot_browser_rejected'],
  ]) { const ws = socket(), c = new BrowserTurnCollector('id'); c.sent(sent('id'), ws); assert.throws(() => c.received(frame, ws), { code }); }
});
test('rejects attachment conversation mismatch and interference', () => {
  const c = new BrowserTurnCollector('id'); c.setReceipts([{ conversationId: 'different' }]);
  assert.throws(() => c.sent(sent('id'), socket()), { code: 'upload_conversation_mismatch' });
  const d = new BrowserTurnCollector('id'); assert.throws(() => d.setReceipts([{ conversationId: 'a' }, { conversationId: 'b' }]), { code: 'upload_conversation_mismatch' });
  const e = new BrowserTurnCollector('id'), ws = socket(); e.sent(sent('id'), ws);
  assert.throws(() => e.sent(sent('someone typing'), ws), { code: 'browser_interference' });
});
test('known upload receipts require selected file names and do not expose service errors', () => {
  const names = new Set(['a.py']);
  assert.equal(uploadReceipt({ name: 'other', id: 'x' }, names), null);
  assert.equal(uploadReceipt({ fileName: 'a.py', result: { value: 'Success' } }, names), null);
  assert.equal(uploadReceipt({ name: 'a.py', id: 'x' }, names).id, 'x');
  assert.throws(() => uploadReceipt({ fileName: 'a.py', result: { value: 'InvalidRequest', message: 'TOKEN' } }, names), (e) => e.code === 'upload_rejected' && !e.message.includes('TOKEN'));
});
test('upload and socket allowlists exclude lookalike hosts, wrong schemes and arbitrary endpoints', () => {
  assert.equal(isChathub(socket().url()), true); assert.equal(isChathub('wss://substrate.office.com.bad/m365Copilot/Chathub'), false);
  assert.equal(uploadEndpoint('https://substrate.office.com/m365Copilot/UploadFile'), true);
  assert.equal(uploadEndpoint('https://tenant.sharepoint.com/_api/v2.0/drive/items'), true);
  for (const url of ['http://substrate.office.com/m365Copilot/UploadFile', 'https://evil.test/upload', 'https://substrate.office.com/elsewhere']) assert.equal(Boolean(uploadEndpoint(url)), false);
});
test('attachment payloads retain exact source bytes and native extension with collision-free names', () => {
  const text = '\ufeffprint("hello")\r\n', f = { path: 'src/file.py', text, sha256: sha256(text), bytes: Buffer.byteLength(text) };
  const a = uploadPayload(f), b = uploadPayload({ ...f, path: 'tests/file.py' });
  assert.equal(a.buffer.toString(), text); assert.match(a.name, /\.py$/); assert.notEqual(a.name, b.name);
  assert.ok(!a.name.includes('/')); assert.ok(!attachmentName(f).includes('src/'));
});
test('input accept is honored, not bypassed by silent extension conversion', () => {
  const p = { name: 'a.py', mimeType: 'text/plain' };
  for (const a of ['', '.txt,.py', 'text/*', '*/*']) assert.equal(acceptsFile(a, p), true);
  for (const a of ['.pdf,.docx', 'image/*']) assert.equal(acceptsFile(a, p), false);
});
test('upload manifests have hashes/names but no source text; hybrid adds bounded inventory', () => {
  const f = { path: 'a.js', sha256: sha256('VERY_PRIVATE_CODE'), bytes: 17, text: 'VERY_PRIVATE_CODE' };
  for (const mode of ['upload', 'hybrid']) {
    const m = uploadManifest({ id: 'id', selected: [f], project: 'one', mode, inventory: ['b.js'] });
    assert.ok(!m.includes('VERY_PRIVATE_CODE')); assert.ok(m.includes(attachmentName(f)));
    assert.equal(m.includes('"inventory"'), mode === 'hybrid');
  }
});
