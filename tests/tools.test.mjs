import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolShim } from '../src/tool-shim.mjs';
import { normalizeRequest } from '../src/contracts.mjs';
import { toolRequest, fakeCore } from './helpers.mjs';
function fixture(overrides = {}, mode = 'guarded') {
  const request = normalizeRequest({ ...toolRequest(), ...overrides });
  return createToolShim(fakeCore(), request, mode, '1234');
}
function wrapped(shim, calls) { return shim.begin + '\n' + JSON.stringify(calls) + '\n' + shim.end; }
const echo = { tool: 'echo', arguments: { text: 'hi' } };
test('guarded call uses validated name, JSON args and fresh ID', () => {
  const shim = fixture(); const a = shim.parse(wrapped(shim, echo)); const b = shim.parse(wrapped(shim, echo));
  assert.equal(a.calls[0].function.name, 'echo'); assert.notEqual(a.calls[0].id, b.calls[0].id);
});
test('ordinary code examples never become calls in guarded auto mode', () => {
  const shim = fixture({ tool_choice: 'auto' }); const text = 'Example:\n```bash\necho hello\n```';
  assert.deepEqual(shim.parse(text), { content: text, calls: [] });
});
test('none is never parsed as calls', () => {
  const shim = fixture({ tool_choice: 'none' }); assert.equal(shim.parse(JSON.stringify(echo)).calls.length, 0);
});
test('required cannot silently degrade to prose', () => assert.throws(() => fixture().parse('I did it.'), /required tool call/));
test('incorrect nonce and incomplete markers fail closed', () => {
  const shim = fixture(); assert.throws(() => shim.parse('<<<LOCAL_TOOLS:ffff>>>\n{}'), /envelope/);
  assert.throws(() => shim.parse(shim.begin + '\n{}'), /Incomplete/);
});
test('unknown names and invalid argument schema fail closed', () => {
  const shim = fixture(); assert.throws(() => shim.parse(wrapped(shim, { tool: 'shell', arguments: {} })), /unavailable/);
  assert.throws(() => shim.parse(wrapped(shim, { tool: 'echo', arguments: { text: 7 } })), /validation/);
  assert.throws(() => shim.parse(wrapped(shim, { tool: 'echo', arguments: {} })), /Missing required/);
});
test('parallel false rejects multiple calls instead of truncating', () => {
  const shim = fixture(); assert.throws(() => shim.parse(wrapped(shim, [echo, echo])), /Multiple calls/);
});
test('parallel true preserves all validated calls', () => {
  const shim = fixture({ parallel_tool_calls: true }); assert.equal(shim.parse(wrapped(shim, [echo, echo])).calls.length, 2);
});
test('cramt mode uses upstream parser but retains validation', () => {
  const shim = fixture({}, 'cramt'); assert.equal(shim.parse(JSON.stringify(echo)).calls.length, 1);
  assert.throws(() => shim.parse(JSON.stringify({ ...echo, arguments: { text: false } })), /validation/);
});
