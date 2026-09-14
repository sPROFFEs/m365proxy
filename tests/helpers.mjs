// Deliberately fake transport/parser for offline adapter tests. Never used by CLI.
import { EventEmitter } from 'node:events';
export const ECHO = { type: 'function', function: { name: 'echo', description: 'Echo text locally', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } };
// Most legacy fixtures exercise transport/write behavior rather than adaptive
// selection, so keep their historical "always provide project context" policy.
// Dedicated workspace tests override this with contextPolicy:'adaptive'.
export const config = { host: '127.0.0.1', port: 0, defaultModel: 'm365-copilot', toolMode: 'guarded', repairAttempts: 0, maxTools: 16, maxSessions: 16, sessionTtlMs: 900000, maxBodyBytes: 1048576, maxOutputChars: 1048576, requestTimeoutMs: 3000, compatMode: true, contextPolicy: 'always' };
export const basic = () => ({ model: 'm365-copilot', messages: [{ role: 'user', content: 'Hello' }] });
export const toolRequest = () => ({ ...basic(), tools: [structuredClone(ECHO)], tool_choice: 'required' });
export function streamOf(text, extra = {}) {
  return { fullText: text, ...extra, async *[Symbol.asyncIterator]() { yield text; } };
}
export function envelope(prompt, call = { tool: 'echo', arguments: { text: 'hello' } }) {
  const nonce = prompt.match(/<<<LOCAL_TOOLS:([a-f0-9]+)>>>/)?.[1];
  if (!nonce) throw new Error('Fixture did not receive envelope instructions.');
  return `<<<LOCAL_TOOLS:${nonce}>>>\n${JSON.stringify(call)}\n<<<END_LOCAL_TOOLS:${nonce}>>>`;
}
export function fakeCore() {
  return {
    getAvailableModels: () => ['m365-copilot', 'quick'],
    formatMessages: (messages, tools = [], choice) => JSON.stringify({ messages, tools, choice }),
    parseToolCalls(text) {
      let data;
      try { data = JSON.parse(text.trim()); } catch { return { hasToolCalls: false, toolCalls: [], textContent: text }; }
      const calls = (Array.isArray(data) ? data : [data]).filter((c) => c?.tool).map((c) => ({ id: 'fake', type: 'function', function: { name: c.tool, arguments: JSON.stringify(c.arguments) } }));
      return { hasToolCalls: calls.length > 0, toolCalls: calls, textContent: calls.length ? null : text };
    },
    isProseDocument: () => false,
  };
}
export function fakeAuth() {
  const auth = new EventEmitter();
  auth.getToken = async () => 'synthetic-test-credential';
  auth.status = () => ({ state: 'ready' });
  return auth;
}
export function jwtUrl({ oid = '11111111-1111-1111-1111-111111111111', tid = '22222222-2222-2222-2222-222222222222', exp = Math.floor(Date.now() / 1000) + 3600, host = 'substrate.office.com', protocol = 'wss' } = {}) {
  const payload = Buffer.from(JSON.stringify({ oid, tid, exp, aud: 'https://substrate.office.com' })).toString('base64url');
  return `${protocol}://${host}/m365Copilot/Chathub/${oid}@${tid}?access_token=eyJhbGciOiJub25lIn0.${payload}.synthetic`;
}
