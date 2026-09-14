import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest } from '../src/contracts.mjs';
import { compileSchema } from '../src/schema.mjs';
import { basic, toolRequest, ECHO } from './helpers.mjs';

test('plain chat defaults to no tools', () => {
  const request = normalizeRequest(basic());
  assert.equal(request.toolChoice, 'none'); assert.equal(request.activeTools.length, 0);
});
test('developer/text arrays are normalized explicitly', () => {
  const request = normalizeRequest({ messages: [{ role: 'developer', content: 'instruction' }, { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] });
  assert.equal(request.messages[0].role, 'system'); assert.equal(request.messages[1].content, 'a\nb');
});
for (const parameter of ['temperature', 'max_tokens', 'response_format', 'stop']) test(`strict mode rejects unsupported ${parameter}`, () => {
  assert.throws(() => normalizeRequest({ ...basic(), [parameter]: 1 }, { compatMode: false }), /Unsupported parameter/);
});
test('compat mode ignores common OpenAI tuning controls and records them', () => {
  const request = normalizeRequest({ ...basic(), reasoning_effort: 'high', temperature: 0.2, max_tokens: 100 });
  assert.deepEqual(request.ignoredParameters, ['max_tokens', 'reasoning_effort', 'temperature']);
});
test('legacy functions and function_call are translated in compat mode', () => {
  const request = normalizeRequest({ ...basic(), functions: [ECHO.function], function_call: { name: 'echo' } });
  assert.equal(request.activeTools[0].function.name, 'echo');
  assert.equal(request.toolChoice.function.name, 'echo');
});
test('multimodal parts are rejected', () => assert.throws(() => normalizeRequest({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }), /Only text/));
test('duplicate tools are rejected', () => assert.throws(() => normalizeRequest({ ...basic(), tools: [ECHO, ECHO] }), /unique/));
test('forced name must exist', () => assert.throws(() => normalizeRequest({ ...toolRequest(), tool_choice: { type: 'function', function: { name: 'missing' } } }), /available/));
test('none suppresses active definitions', () => assert.equal(normalizeRequest({ ...toolRequest(), tool_choice: 'none' }).activeTools.length, 0));
test('required without tools is rejected', () => assert.throws(() => normalizeRequest({ ...basic(), tool_choice: 'required' }), /requires tools/));
test('orphan tool result is rejected', () => assert.throws(() => normalizeRequest({ messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'result' }] }), /Unmatched/));
test('tool call IDs are correlated across all results', () => {
  const messages = [basic().messages[0], { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"x"}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'x' }];
  assert.equal(normalizeRequest({ messages }).messages[2].name, 'echo');
  assert.throws(() => normalizeRequest({ messages: messages.slice(0, 2) }), /pending/);
  assert.throws(() => normalizeRequest({ messages: [...messages, messages[2]] }), /Unmatched/);
});
test('partial multi-call results block the next completion', () => {
  const calls = ['a', 'b'].map((id) => ({ id, type: 'function', function: { name: 'echo', arguments: '{}' } }));
  assert.throws(() => normalizeRequest({ messages: [basic().messages[0], { role: 'assistant', tool_calls: calls }, { role: 'tool', tool_call_id: 'a', content: 'x' }] }), /pending/);
});
test('usage requests are accepted in compat mode without fabricating metrics', () => {
  const request = normalizeRequest({ ...basic(), stream_options: { include_usage: true } });
  assert.equal(request.includeUsage, true);
  assert.ok(request.ignoredParameters.includes('stream_options.include_usage'));
});
test('unknown controls still fail in compat mode', () => assert.throws(() => normalizeRequest({ ...basic(), totally_unknown_control: true }), /Unsupported parameter/));
test('schema object validates required, extra properties and types', () => {
  const check = compileSchema(ECHO.function.parameters);
  assert.equal(check({ text: 'hello' }), null);
  assert.match(check({}), /Missing required/);
  assert.match(check({ text: 2 }), /type/);
  assert.match(check({ text: 'x', extra: true }), /prohibited/);
});
test('schema local references, array bounds and oneOf work', () => {
  const check = compileSchema({ type: 'object', $defs: { value: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', minLength: 1 }] } }, properties: { x: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { $ref: '#/$defs/value' } } }, required: ['x'] });
  assert.equal(check({ x: [1, 'x'] }), null);
  assert.ok(check({ x: [0] })); assert.ok(check({ x: [1, 1] })); assert.ok(check({ x: [] }));
});
test('external refs and unsupported keywords fail closed', () => {
  assert.throws(() => compileSchema({ $ref: 'https://example.invalid/schema' }), /Only local/);
  assert.throws(() => compileSchema({ type: 'string', format: 'email' }), /Unsupported/);
});
test('numeric and array tuple constraints are enforced', () => {
  const check = compileSchema({ type: 'array', prefixItems: [{ const: 'header' }, { type: 'number', exclusiveMinimum: 0, maximum: 2, multipleOf: 0.5 }], items: false });
  assert.equal(check(['header', 1.5]), null); assert.ok(check(['header', 1.1])); assert.ok(check(['header', 1, 3]));
});
test('recursive schema has a bounded evaluation depth', () => {
  const check = compileSchema({ $ref: '#' });
  assert.match(check({}), /recursion/);
});
test('nullable does not override enum assertions', () => {
  const check = compileSchema({ type: 'string', nullable: true, enum: ['x'] });
  assert.ok(check(null)); assert.equal(compileSchema({ type: 'string', nullable: true })(null), null);
});
test('complex recursive branches cannot cause unbounded evaluation', () => {
  const check = compileSchema({ anyOf: [{ $ref: '#' }, { $ref: '#' }] });
  assert.ok(check({}));
});
test('regular-expression schemas are rejected rather than exposing a regex denial of service', () => {
  assert.throws(() => compileSchema({ type: 'string', pattern: '(a+)+$' }), /Unsupported/);
});
