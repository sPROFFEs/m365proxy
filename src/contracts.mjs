import { invalid } from './errors.mjs';
import { plainObject } from './util.mjs';
import { compileSchema } from './schema.mjs';

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const nativeAllowed = new Set([
  'model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls',
  'stream', 'stream_options', 'n', 'user',
]);

// Common OpenAI/OpenAI-compatible knobs that Copilot web does not expose.
// In compatibility mode they are accepted and ignored rather than making
// agent clients fail before inference. Strict mode keeps the old fail-closed
// behaviour for debugging.
const compatIgnored = new Set([
  'reasoning_effort', 'reasoning', 'verbosity', 'store', 'service_tier',
  'metadata', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty',
  'seed', 'max_tokens', 'max_completion_tokens', 'logprobs', 'top_logprobs',
  'stop', 'response_format', 'prediction', 'modalities', 'audio',
  'web_search_options', 'prompt_cache_key', 'safety_identifier',
]);

function textContent(value, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((p) => plainObject(p) && ['text', 'input_text', 'output_text'].includes(p.type) && typeof p.text === 'string')) {
    return value.map((p) => p.text).join('\n');
  }
  throw invalid('Only text message content is supported.', 'messages');
}

function legacyTools(body, ignored) {
  let tools = body.tools;
  let choice = body.tool_choice;
  if (tools === undefined && body.functions !== undefined) {
    if (!Array.isArray(body.functions)) throw invalid('functions must be an array.', 'functions');
    tools = body.functions.map((f) => ({ type: 'function', function: f }));
    ignored.delete('functions');
  }
  if (choice === undefined && body.function_call !== undefined) {
    const old = body.function_call;
    if (typeof old === 'string') choice = old;
    else if (plainObject(old) && typeof old.name === 'string') choice = { type: 'function', function: { name: old.name } };
    else throw invalid('function_call must be auto, none, or a named function.', 'function_call');
    ignored.delete('function_call');
  }
  return { tools, choice };
}

export function normalizeRequest(body, {
  maxTools = 16,
  defaultModel = 'm365-copilot',
  compatMode = true,
} = {}) {
  if (!plainObject(body)) throw invalid('Request must be a JSON object.');

  const ignored = new Set();
  for (const key of Object.keys(body)) {
    if (nativeAllowed.has(key)) continue;
    if (compatMode && (compatIgnored.has(key) || key === 'functions' || key === 'function_call')) {
      ignored.add(key);
      continue;
    }
    throw invalid(`Unsupported parameter: ${key}. ${compatMode ? 'This field cannot be safely adapted to Copilot web.' : 'Strict mode does not ignore unsupported controls.'}`, key);
  }

  const legacy = legacyTools(body, ignored);
  if (body.n !== undefined && body.n !== 1) throw invalid('Only n=1 is supported.', 'n');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw invalid('stream must be boolean.', 'stream');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw invalid('parallel_tool_calls must be boolean.', 'parallel_tool_calls');

  let includeUsage = false;
  if (body.stream_options !== undefined) {
    if (!plainObject(body.stream_options)) throw invalid('stream_options must be an object.', 'stream_options');
    for (const [key, value] of Object.entries(body.stream_options)) {
      if (key === 'include_usage') {
        if (typeof value !== 'boolean') throw invalid('stream_options.include_usage must be boolean.', 'stream_options');
        includeUsage = value;
      } else if (!compatMode) {
        throw invalid(`Unsupported stream_options field: ${key}.`, 'stream_options');
      }
    }
    if (includeUsage) ignored.add('stream_options.include_usage');
  }

  const model = body.model ?? defaultModel;
  if (typeof model !== 'string' || model.length > 256 || !model) throw invalid('model must be a nonempty string.', 'model');
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 1000) throw invalid('messages must contain between 1 and 1000 messages.', 'messages');

  const pending = new Map();
  const usedIds = new Set();
  const messages = body.messages.map((m) => {
    if (!plainObject(m) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) throw invalid('Unsupported message role.', 'messages');
    if (pending.size && m.role !== 'tool') throw invalid('All pending tool calls must receive results before the next message.', 'messages');
    const out = {
      role: m.role === 'developer' ? 'system' : m.role,
      content: textContent(m.content ?? (m.role === 'assistant' ? null : undefined), m.role === 'assistant'),
    };

    if (m.role === 'assistant' && m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls) || !m.tool_calls.length || m.tool_calls.length > 32) throw invalid('assistant.tool_calls must be a nonempty array of at most 32 calls.', 'messages');
      out.tool_calls = m.tool_calls.map((c) => {
        if (!plainObject(c) || c.type !== 'function' || typeof c.id !== 'string' || !c.id || c.id.length > 128 || usedIds.has(c.id) || !plainObject(c.function) || !NAME.test(c.function.name ?? '') || typeof c.function.arguments !== 'string') throw invalid('Malformed or duplicate historical tool call.', 'messages');
        let args;
        try { args = JSON.parse(c.function.arguments); } catch { throw invalid('Historical tool arguments must be valid JSON.', 'messages'); }
        if (!plainObject(args)) throw invalid('Historical tool arguments must be a JSON object.', 'messages');
        usedIds.add(c.id);
        pending.set(c.id, c.function.name);
        return { id: c.id, type: 'function', function: { name: c.function.name, arguments: JSON.stringify(args) } };
      });
    } else if (m.tool_calls !== undefined) {
      throw invalid('tool_calls is only valid on assistant messages.', 'messages');
    }

    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !pending.has(m.tool_call_id)) throw invalid('Unmatched or duplicate tool result.', 'messages');
      out.tool_call_id = m.tool_call_id;
      out.name = pending.get(m.tool_call_id);
      pending.delete(m.tool_call_id);
    }
    return out;
  });

  if (pending.size) throw invalid('Provide results for all pending tool calls before requesting another completion.', 'messages');
  if (!['user', 'tool'].includes(messages.at(-1).role)) throw invalid('The final message must be user or tool.', 'messages');

  const tools = legacy.tools ?? [];
  if (!Array.isArray(tools) || tools.length > maxTools) throw invalid(`At most ${maxTools} tools are accepted.`, 'tools');
  const validators = new Map();
  const normalizedTools = tools.map((t) => {
    if (!plainObject(t) || t.type !== 'function' || !plainObject(t.function) || !NAME.test(t.function.name ?? '')) throw invalid('Only named function tools are supported.', 'tools');
    const f = t.function;
    if (validators.has(f.name)) throw invalid('Tool names must be unique.', 'tools');
    if (f.description !== undefined && (typeof f.description !== 'string' || f.description.length > 16000)) throw invalid('Invalid tool description.', 'tools');
    const parameters = f.parameters ?? { type: 'object', properties: {} };
    if (!plainObject(parameters)) throw invalid('Tool parameters must be an object schema.', 'tools');
    validators.set(f.name, compileSchema(parameters));
    return { type: 'function', function: { name: f.name, description: f.description ?? '', parameters } };
  });

  let toolChoice = legacy.choice ?? (tools.length ? 'auto' : 'none');
  if (!['auto', 'none', 'required'].includes(toolChoice)) {
    if (!plainObject(toolChoice) || toolChoice.type !== 'function' || !validators.has(toolChoice.function?.name)) throw invalid('tool_choice must name an available function.', 'tool_choice');
    toolChoice = { type: 'function', function: { name: toolChoice.function.name } };
  }
  if (!tools.length && toolChoice !== 'none' && toolChoice !== 'auto') throw invalid('tool_choice requires tools.', 'tool_choice');
  const activeTools = toolChoice === 'none' ? [] : typeof toolChoice === 'object' ? normalizedTools.filter((t) => t.function.name === toolChoice.function.name) : normalizedTools;

  return {
    model,
    messages,
    tools: normalizedTools,
    activeTools,
    toolChoice,
    validators,
    stream: body.stream === true,
    parallel: body.parallel_tool_calls === true,
    includeUsage,
    ignoredParameters: [...ignored].sort(),
  };
}
