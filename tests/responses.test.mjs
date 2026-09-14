import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesToChatRequest, chatToResponse } from '../src/responses.mjs';

test('Responses text input and instructions translate to chat messages', () => {
  const adapted = responsesToChatRequest({ model: 'm365-copilot', instructions: 'Be concise', input: 'hello' });
  assert.deepEqual(adapted.body.messages, [{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'hello' }]);
});

test('Responses function calls and outputs round-trip into chat history', () => {
  const adapted = responsesToChatRequest({
    model: 'm365-copilot',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'run echo' }] },
      { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"text":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'x' },
    ],
    tools: [{ type: 'function', name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
  });
  assert.equal(adapted.body.messages[1].tool_calls[0].id, 'call_1');
  assert.equal(adapted.body.messages[2].tool_call_id, 'call_1');
  assert.equal(adapted.body.tools[0].function.name, 'echo');
});

test('Responses unsupported tuning is ignored only in compatibility mode', () => {
  const adapted = responsesToChatRequest({ model: 'm365-copilot', input: 'x', reasoning: { effort: 'high' } });
  assert.deepEqual(adapted.ignored, ['responses.reasoning']);
  assert.throws(() => responsesToChatRequest({ model: 'm365-copilot', input: 'x', reasoning: {} }, { compatMode: false }), /Unsupported/);
});

test('chat tool calls become Responses function_call output items', () => {
  const result = chatToResponse({
    model: 'm365-copilot',
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"x"}' } }] } }],
    x_m365: {},
  });
  assert.equal(result.output[0].type, 'function_call');
  assert.equal(result.output[0].call_id, 'call_1');
  assert.equal(result.output[0].name, 'echo');
});
