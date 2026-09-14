import { randomUUID } from 'node:crypto';
import { invalid } from './errors.mjs';
import { plainObject } from './util.mjs';

const nativeFields = new Set(['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream']);
const ignoredFields = new Set([
  'reasoning', 'text', 'max_output_tokens', 'previous_response_id', 'truncation',
  'store', 'metadata', 'include', 'background', 'service_tier', 'temperature',
  'top_p', 'prompt_cache_key', 'safety_identifier', 'user',
]);

function partText(content, param = 'input') {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const chunks = [];
    for (const part of content) {
      if (typeof part === 'string') { chunks.push(part); continue; }
      if (!plainObject(part) || !['input_text', 'output_text', 'text'].includes(part.type) || typeof part.text !== 'string') {
        throw invalid('Only text Responses API content is supported.', param);
      }
      chunks.push(part.text);
    }
    return chunks.join('\n');
  }
  throw invalid('Only text Responses API content is supported.', param);
}

function normalizeResponseTools(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw invalid('tools must be an array.', 'tools');
  return tools.map((tool) => {
    if (!plainObject(tool) || tool.type !== 'function' || typeof tool.name !== 'string') throw invalid('Only Responses function tools are supported.', 'tools');
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    };
  });
}

function normalizeResponseToolChoice(choice) {
  if (choice === undefined || typeof choice === 'string') return choice;
  if (plainObject(choice) && choice.type === 'function' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  throw invalid('Unsupported Responses tool_choice.', 'tool_choice');
}

function pushFunctionCall(messages, item) {
  const callId = item.call_id ?? item.id;
  if (typeof callId !== 'string' || !callId || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw invalid('Malformed function_call input item.', 'input');
  const call = { id: callId, type: 'function', function: { name: item.name, arguments: item.arguments } };
  const last = messages.at(-1);
  if (last?.role === 'assistant' && Array.isArray(last.tool_calls) && last.content === null) last.tool_calls.push(call);
  else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
}

function inputToMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) throw invalid('input must be a nonempty string or array.', 'input');
  const messages = [];
  for (const item of input) {
    if (!plainObject(item)) throw invalid('Malformed Responses input item.', 'input');
    if (item.type === 'function_call') { pushFunctionCall(messages, item); continue; }
    if (item.type === 'function_call_output') {
      if (typeof item.call_id !== 'string' || !item.call_id) throw invalid('function_call_output requires call_id.', 'input');
      const output = typeof item.output === 'string' ? item.output : plainObject(item.output) || Array.isArray(item.output) ? JSON.stringify(item.output) : String(item.output ?? '');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
      continue;
    }
    const role = item.role;
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) throw invalid('Unsupported Responses message role.', 'input');
    messages.push({ role, content: partText(item.content, 'input') });
  }
  return messages;
}

export function responsesToChatRequest(body, { compatMode = true } = {}) {
  if (!plainObject(body)) throw invalid('Request must be a JSON object.');
  const ignored = [];
  for (const key of Object.keys(body)) {
    if (nativeFields.has(key)) continue;
    if (compatMode && ignoredFields.has(key)) { ignored.push(`responses.${key}`); continue; }
    throw invalid(`Unsupported Responses API parameter: ${key}.`, key);
  }
  const messages = inputToMessages(body.input);
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== 'string') throw invalid('instructions must be a string.', 'instructions');
    if (body.instructions) messages.unshift({ role: 'system', content: body.instructions });
  }
  return {
    body: {
      model: body.model,
      messages,
      tools: normalizeResponseTools(body.tools),
      tool_choice: normalizeResponseToolChoice(body.tool_choice),
      parallel_tool_calls: body.parallel_tool_calls,
      stream: body.stream,
    },
    ignored,
  };
}

function outputItems(chatResult) {
  const message = chatResult.choices[0].message;
  const output = [];
  if (message.content) {
    output.push({
      id: 'msg_' + randomUUID().replaceAll('-', ''),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }
  for (const call of message.tool_calls ?? []) {
    output.push({
      id: 'fc_' + randomUUID().replaceAll('-', ''),
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }
  return output;
}

export function chatToResponse(chatResult, { id, createdAt } = {}) {
  const responseId = id ?? 'resp_' + randomUUID().replaceAll('-', '');
  const created = createdAt ?? Math.floor(Date.now() / 1000);
  const output = outputItems(chatResult);
  return {
    id: responseId,
    object: 'response',
    created_at: created,
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: chatResult.model,
    output,
    output_text: output.filter((x) => x.type === 'message').flatMap((x) => x.content).filter((x) => x.type === 'output_text').map((x) => x.text).join(''),
    parallel_tool_calls: false,
    x_m365: chatResult.x_m365,
  };
}

export function responseShell({ id, createdAt, model, status = 'in_progress', output = [] }) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    model,
    output,
  };
}
