// Passive, bounded SignalR observer for a single browser-owned turn. This module
// never builds an authenticated URL or sends a WebSocket frame. Payloads are not
// logged or persisted. Unknown completion formats fail rather than hang/succeed.
import { ProxyError } from './errors.mjs';
export function isChathub(raw) {
  try { const u = new URL(raw); return u.protocol === 'wss:' && u.hostname === 'substrate.office.com' && /^\/m365copilot\/chathub(?:\/|$)/i.test(u.pathname); } catch { return false; }
}
export class SignalRFrames {
  constructor(limit = 4194304) { this.buffer = ''; this.limit = limit; }
  feed(payload) {
    const chunk = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
    this.buffer += chunk;
    if (this.buffer.length > this.limit || (this.buffer.length * 3 > this.limit && Buffer.byteLength(this.buffer) > this.limit)) {
      throw new ProxyError(502, 'browser_frame_limit', 'Browser protocol frame exceeded its local size limit.');
    }
    const frames = []; let i;
    while ((i = this.buffer.indexOf('\x1e')) !== -1) {
      const part = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
      if (!part.trim()) continue;
      try { frames.push(JSON.parse(part)); }
      catch { throw new ProxyError(502, 'browser_protocol_changed', 'Chathub emitted a non-JSON SignalR record. No successful response was synthesized.'); }
    }
    return frames;
  }
}
function conversation(arg, url) {
  if (typeof arg?.conversationId === 'string') return arg.conversationId;
  try { for (const [k, v] of new URL(url).searchParams) if (k.toLowerCase() === 'conversationid') return v; } catch {}
  return null;
}
function resultError(value) {
  if (value === undefined || value === null || value === 'Success' || value === 'success' || value === '') return null;
  if (/thrott|rate.?limit|quota/i.test(String(value))) return new ProxyError(429, 'copilot_throttled', 'Copilot reported a quota/rate limit. The browser turn was not replayed.');
  return new ProxyError(502, 'copilot_browser_rejected', 'Copilot rejected or did not complete the browser turn. No success or automatic replay was generated.');
}
export class BrowserTurnCollector {
  constructor(marker, { endMarker = null, onText = () => {}, maxChars = 1048576 } = {}) {
    this.marker = marker; this.endMarker = endMarker; this.onText = onText; this.maxChars = maxChars;
    this.bound = null; this.done = false; this.text = ''; this.parts = new Map();
    this.expectedConversations = new Set();
  }
  setReceipts(receipts) {
    for (const r of receipts) if (r.conversationId) this.expectedConversations.add(r.conversationId.toLowerCase());
    if (this.expectedConversations.size > 1) throw new ProxyError(502, 'upload_conversation_mismatch', 'Uploaded files were associated with different conversations. No prompt was sent.');
  }
  sent(frame, socket) {
    if (this.done) return;
    if (frame?.type !== 4 || String(frame.target).toLowerCase() !== 'chat') return;
    const arg = frame.arguments?.[0]; const text = arg?.message?.text;
    if (this.bound) throw new ProxyError(409, 'browser_interference', 'Another chat invocation appeared during the owned turn. Do not interact with its temporary tab.');
    if (typeof text !== 'string' || !text.includes(this.marker) || (this.endMarker && !text.includes(this.endMarker))) return;
    const id = conversation(arg, socket.url());
    if (id && this.expectedConversations.size && !this.expectedConversations.has(id.toLowerCase()))
      throw new ProxyError(502, 'upload_conversation_mismatch', 'The prompt conversation does not match the observed upload receipt.');
    this.bound = { socket, invocationId: String(frame.invocationId ?? ''), conversationId: id };
  }
  received(frame, socket) {
    if (!this.bound || socket !== this.bound.socket || this.done) return;
    if (frame.invocationId !== undefined && String(frame.invocationId) !== this.bound.invocationId) return;
    if (frame.error) throw new ProxyError(502, 'copilot_browser_rejected', 'Chathub returned an invocation error. No raw service error is exposed.');
    if (frame.type === 1 || frame.type === 2) {
      const items = frame.type === 1 ? (Array.isArray(frame.arguments) ? frame.arguments : []) : [frame.item ?? frame.result ?? {}];
      for (const item of items) {
        const error = resultError(item?.result?.value); if (error) throw error;
        for (const msg of item?.messages ?? []) {
          if (msg?.author !== 'bot' && msg?.author !== 'assistant') continue;
          const kind = String(msg.messageType ?? 'Chat');
          if (/disengaged|blocked|refusal|contentfilter/i.test(kind)) throw new ProxyError(502, 'copilot_refusal', 'Copilot refused or disengaged. The proxy does not retry around that result.');
          if (!['Chat', 'Answer', ''].includes(kind) || typeof msg.text !== 'string') continue;
          const key = String(msg.messageId ?? msg.id ?? 'answer');
          const old = this.parts.get(key) ?? '';
          this.parts.set(key, msg.text);
          this.text = [...this.parts.values()].join('\n');
          if (this.text.length > this.maxChars) throw new ProxyError(502, 'output_limit', 'Copilot output exceeded the local size limit.');
          // Used only for liveness, not outward streaming. Final text can rewrite
          // an earlier cumulative frame; we expose it once after completion.
          if (msg.text !== old) this.onText(msg.text.startsWith(old) ? msg.text.slice(old.length) : msg.text);
        }
      }
      if (frame.type === 2) {
        if (!this.text.trim()) throw new ProxyError(502, 'empty_response', 'Copilot completed the owned browser turn without answer text.');
        this.done = true;
      }
    } else if (frame.type === 3 && !this.done) {
      throw new ProxyError(502, 'browser_incomplete_turn', 'Chathub closed the invocation without a recognized final answer record.');
    }
  }
}

// Read ONLY metadata in recognized upload responses. A 200 by itself is not an
// upload receipt; a file ID/name or explicit Microsoft success is required.
export function uploadEndpoint(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return false;
    if (u.hostname === 'substrate.office.com') return /^\/m365copilot\/uploadfile(?:\/|$)/i.test(u.pathname);
    if (u.hostname === 'graph.microsoft.com' || u.hostname.endsWith('.sharepoint.com'))
      return /(?:\/drive|\/_api\/|\/content|\/upload)/i.test(u.pathname);
  } catch {}
  return false;
}
export function uploadReceipt(json, expectedNames) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const name = json.fileName ?? json.name ?? json.d?.Name;
  if (!expectedNames.has(name)) return null;
  const value = json.result?.value;
  if (json.error || (value !== undefined && !/^success$/i.test(String(value))))
    throw new ProxyError(422, 'upload_rejected', 'Copilot rejected a selected file. Check its format, size and tenant policy. No prompt was sent.');
  const id = json.docId ?? json.id ?? json.d?.UniqueId;
  if (typeof id !== 'string' || !id || id.length > 2048) return null;
  return { name, id, conversationId: typeof json.conversationId === 'string' ? json.conversationId : null };
}
