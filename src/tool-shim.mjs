import { randomBytes, randomUUID } from 'node:crypto';
import { contractError } from './errors.mjs';
import { plainObject } from './util.mjs';

export function createToolShim(core, request, mode = 'guarded', fixedNonce) {
  const nonce = fixedNonce ?? randomBytes(12).toString('hex');
  const begin = `<<<LOCAL_TOOLS:${nonce}>>>`;
  const end = `<<<END_LOCAL_TOOLS:${nonce}>>>`;
  const activeNames = new Set(request.activeTools.map((t) => t.function.name));
  const required = request.toolChoice === 'required' || typeof request.toolChoice === 'object';
  const instruction = !request.activeTools.length ? '' : mode === 'guarded' ? [
    '\nLocal client tool-call protocol (the client, not this chat service, executes tools):',
    `If issuing a real tool call, put the fenced tool calls described above between these exact marker lines:`,
    begin, '<fenced tool call(s)>', end,
    'Do not include these markers when explaining code, quoting examples, or giving a final answer.',
    'Never claim that a local command ran before the client has returned its tool result.',
    request.parallel ? 'Multiple independent calls may be proposed.' : 'Propose at most one call in this turn.',
    required ? 'For this turn the client requires a call to one of the supplied tools.' : 'Use tools only when needed; otherwise answer normally.',
  ].join('\n') : '\nOnly issue actual calls, not runnable examples. Never claim local execution before receiving a tool result.\n';

  function parse(text) {
    if (!request.activeTools.length) return { content: text, calls: [] };
    let candidate = text;
    let outside = '';
    if (mode === 'guarded') {
      // Line anchoring avoids treating inline marker quotations as calls.
      const normalized = text.replace(/\r\n/g, '\n');
      const lines = normalized.split('\n');
      const starts = lines.flatMap((l, i) => l.trim() === begin ? [i] : []);
      const ends = lines.flatMap((l, i) => l.trim() === end ? [i] : []);
      if (starts.length === 0 && ends.length === 0) {
        if (required || /<<<(?:END_)?LOCAL_TOOLS:/.test(text)) throw contractError('A required tool call did not use the requested envelope.');
        return { content: text, calls: [] };
      }
      if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) throw contractError('Incomplete or repeated tool-call envelope.');
      candidate = lines.slice(starts[0] + 1, ends[0]).join('\n');
      outside = [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)].join('\n').trim();
    }
    const parsed = core.parseToolCalls(candidate, request.activeTools);
    if (!parsed || !Array.isArray(parsed.toolCalls)) throw contractError('Upstream parser returned an incompatible result.');
    if (mode === 'cramt' && core.isProseDocument?.(parsed)) {
      if (required) throw contractError('The model returned a document, not a tool call.');
      return { content: text, calls: [] };
    }
    if (parsed.toolCalls.length === 0) {
      if (required || mode === 'guarded') throw contractError('No valid call was found in the tool response.');
      return { content: text, calls: [] };
    }
    if (!request.parallel && parsed.toolCalls.length > 1) throw contractError('Multiple calls were returned while parallel_tool_calls=false. No call was silently discarded.');
    if (parsed.toolCalls.length > 16) throw contractError('Too many calls in one response.');
    const calls = parsed.toolCalls.map((call) => {
      const name = call.function?.name;
      if (call.type !== 'function' || !activeNames.has(name)) throw contractError('The model selected an unavailable tool.');
      let args;
      try { args = JSON.parse(call.function.arguments); } catch { throw contractError(`Arguments for ${name} are not valid JSON.`); }
      if (!plainObject(args)) throw contractError(`Arguments for ${name} must be an object.`);
      const error = request.validators.get(name)(args);
      if (error) throw contractError(`Arguments for ${name} failed validation: ${error}`);
      return { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    });
    if (mode === 'guarded' && /```|~~~|<<<(?:END_)?LOCAL_TOOLS:/.test(parsed.textContent ?? '')) throw contractError('Unparsed structured content remains inside the tool envelope.');
    const content = [outside, parsed.textContent ?? ''].filter(Boolean).join('\n').trim() || null;
    return { content, calls };
  }
  return { instruction, parse, begin, end };
}
