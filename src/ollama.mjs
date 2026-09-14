// Small Ollama wire adapter for clients configured for /api/chat. This is NOT an
// Ollama server: no model loading, model downloads, embeddings, images or thinking.
// Tools still go through the same validated/emulated tool shim as OpenAI clients.
import { plainObject, sha256, stable } from './util.mjs';
import { invalid } from './errors.mjs';

const supported = new Set(['model', 'messages', 'tools', 'stream', 'tool_choice', 'parallel_tool_calls']);
const controls = new Set(['options', 'think', 'keep_alive', 'logprobs', 'top_logprobs']);

export function ollamaToChatRequest(body, { compatMode = true } = {}) {
  if (!plainObject(body)) throw invalid('Request must be a JSON object.');
  const ignored = new Set();
  for (const key of Object.keys(body)) {
    if (supported.has(key)) continue;
    if (compatMode && controls.has(key)) { ignored.add(`ollama.${key}`); continue; }
    // Unlike a sampling hint, a JSON-schema format is a semantic guarantee.
    throw invalid(`Unsupported Ollama parameter: ${key}. This proxy supports text and emulated function tools only.`, key);
  }
  if (!Array.isArray(body.messages)) throw invalid('messages must be an array.', 'messages');
  const pending = [];
  const messages = body.messages.map((message, messageIndex) => {
    if (!plainObject(message)) throw invalid('Invalid Ollama message.', 'messages');
    if (message.images !== undefined && (!Array.isArray(message.images) || message.images.length)) throw invalid('Images are not supported by this text-only bridge.', 'messages');
    if (message.thinking) ignored.add('ollama.messages.thinking');
    const out = { role: message.role, content: message.content ?? (message.role === 'assistant' ? null : undefined) };
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.role !== 'assistant') throw invalid('Invalid Ollama tool_calls.', 'messages');
      if (message.tool_calls.length) out.tool_calls = message.tool_calls.map((call, callIndex) => {
        if (!plainObject(call?.function)) throw invalid('Malformed historical tool call.', 'messages');
        let args = call.function.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw invalid('Invalid tool arguments JSON.', 'messages'); } }
        if (!plainObject(args)) throw invalid('Tool arguments must be a JSON object.', 'messages');
        // Ollama may omit IDs. Deterministic IDs keep resent histories stable.
        const id = call.id ?? 'call_' + sha256(stable([messageIndex, callIndex, call.function.name, args])).slice(0, 32);
        pending.push({ id, name: call.function.name });
        return { id, type: 'function', function: { name: call.function.name, arguments: JSON.stringify(args) } };
      });
    }
    if (message.role === 'tool') {
      let candidates;
      if (message.tool_call_id !== undefined) candidates = pending.filter((call) => call.id === message.tool_call_id);
      else if (message.tool_name !== undefined || message.name !== undefined) candidates = pending.filter((call) => call.name === (message.tool_name ?? message.name));
      else candidates = pending;
      if (candidates.length !== 1) throw invalid('Ambiguous or unmatched Ollama tool result. Supply tool_call_id, or an unambiguous tool_name.', 'messages');
      out.tool_call_id = candidates[0].id;
      pending.splice(pending.indexOf(candidates[0]), 1);
    }
    return out;
  });
  return { body: { model: body.model, messages, tools: body.tools, stream: body.stream ?? true,
    tool_choice: body.tool_choice, parallel_tool_calls: body.parallel_tool_calls }, ignored: [...ignored] };
}
export function ollamaMessage(message) {
  const out = { role: 'assistant', content: message.content ?? '' };
  if (message.tool_calls?.length) out.tool_calls = message.tool_calls.map((call, index) => ({
    id: call.id, type: 'function', function: { index, name: call.function.name, arguments: JSON.parse(call.function.arguments) },
  }));
  return out;
}
export function chatToOllama(result) {
  return { model: result.model, created_at: new Date().toISOString(), message: ollamaMessage(result.choices[0].message),
    done: true, done_reason: 'stop', x_m365: { ...result.x_m365, wire_format: 'ollama', token_usage: 'unavailable' } };
}
const details = () => ({ format: 'remote', family: 'm365-copilot', families: ['m365-copilot'], parameter_size: 'unknown', quantization_level: 'unknown' });
export function ollamaModels(engine) {
  return { models: engine.modelList().data.map(({ id }) => ({ name: id, model: id, modified_at: '1970-01-01T00:00:00Z', size: 0,
    digest: sha256('m365-proxy-routing-label:' + id), details: details() })),
    x_m365: { metadata: 'synthetic routing labels, not downloaded model weights', token_usage: 'unavailable' } };
}
export function ollamaShow(body, engine) {
  if (!plainObject(body) || typeof (body.model ?? body.name) !== 'string') throw invalid('Supply model for /api/show.', 'model');
  const id = body.model ?? body.name;
  if (!id.length || id.length > 256) throw invalid('Invalid model routing label.', 'model');
  const route = engine.routeModel(id);
  return { details: details(), capabilities: ['completion', 'tools'], parameters: '', template: '', modelfile: '', model_info: {},
    x_m365: { upstream_model_route: route, tool_calls_emulated: true, metadata: 'synthetic proxy capabilities; model architecture and context limits are not known' } };
}
