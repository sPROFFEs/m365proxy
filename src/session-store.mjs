import { randomUUID } from 'node:crypto';
import { sha256, stable } from './util.mjs';
import { invalid } from './errors.mjs';
import { detachCleanup } from './lifecycle.mjs';

function currentTurn(messages) {
  // Browser-owned reuse already carries remote history. If a client does not
  // replay byte-identical history (some OpenAI-compatible CLIs rewrite system
  // messages or send only the current turn), send only the current turn rather
  // than duplicating the whole conversation into the persistent Copilot chat.
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') { lastAssistant = i; break; }
  }
  const tail = messages.slice(lastAssistant + 1);
  return tail.length ? tail : messages.slice(-1);
}

// Exact history continuation remains preferred. Browser upload stores may opt
// into a sticky fallback: when there is exactly one reusable remote chat in the
// same workspace/model/tool scope, stateless/dynamically-rewritten clients keep
// using it instead of creating a new browser tab on every request.
export class SessionStore {
  constructor(factory, { maxSessions = 8, sessionTtlMs = 3600000, sessionMaxTurns = 32, clock = Date.now, stickyFallback = false } = {}) {
    this.factory = factory; this.max = maxSessions; this.ttl = sessionTtlMs; this.maxTurns = sessionMaxTurns; this.clock = clock;
    this.stickyFallback = stickyFallback;
    this.entries = new Map();
  }
  drop(entry) { this.entries.delete(entry.id); detachCleanup(() => entry.backend.reset?.()); }
  checkout(request, explicitId) {
    if (explicitId !== undefined && (typeof explicitId !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(explicitId))) throw invalid('X-Session-Id must contain 1-100 letters, digits, underscores, dots or hyphens.');
    const scope = sha256(stable(this.stickyFallback ? { model: request.upstreamModel ?? request.model, context: request.contextIdentity ?? null } : { model: request.upstreamModel ?? request.model, tools: request.tools, context: request.contextIdentity ?? null }));
    const now = this.clock();
    for (const e of [...this.entries.values()]) if (now - e.touched > this.ttl) this.drop(e);
    const exactPrefix = (e) => !request.forceFreshSession && e.history && e.turns < this.maxTurns && e.history.length < request.messages.length && stable(request.messages.slice(0, e.history.length)) === stable(e.history);
    const eligible = (e) => !request.forceFreshSession && e.turns < this.maxTurns && e.scope === scope && (e.backend.reusable?.() ?? true);
    let entry, reason = 'new';
    if (explicitId) {
      entry = [...this.entries.values()].find((e) => e.explicitId === explicitId);
      if (entry && (entry.scope !== scope || !eligible(entry) || (!exactPrefix(entry) && !this.stickyFallback))) { this.drop(entry); entry = undefined; }
      if (entry) reason = exactPrefix(entry) ? 'explicit_exact' : 'explicit_sticky';
    } else {
      const exact = [...this.entries.values()].filter((e) => !e.explicitId && e.scope === scope && exactPrefix(e));
      if (exact.length === 1) { entry = exact[0]; reason = 'exact'; }
      else if (!exact.length && this.stickyFallback && !request.forceFreshSession) {
        const sticky = [...this.entries.values()].filter((e) => !e.explicitId && eligible(e));
        if (sticky.length === 1) { entry = sticky[0]; reason = 'sticky'; }
      }
    }
    if (!entry) {
      if (this.entries.size >= this.max) this.drop([...this.entries.values()].sort((a, b) => a.touched - b.touched)[0]);
      entry = { id: randomUUID(), explicitId, scope, backend: this.factory(), history: null, touched: now, turns: 0 };
      this.entries.set(entry.id, entry);
    }
    entry.touched = now;
    const reused = Boolean(entry.history);
    const delta = !reused ? request.messages : reason === 'exact' || reason === 'explicit_exact'
      ? request.messages.slice(entry.history.length)
      : currentTurn(request.messages);
    return { entry, delta, reused, reason };
  }
  commit(entry, request, assistant) {
    entry.history = [...request.messages, assistant];
    entry.turns = (entry.turns ?? 0) + 1;
    entry.touched = this.clock();
  }
  clear() { for (const e of [...this.entries.values()]) this.drop(e); }
  get size() { return this.entries.size; }
}
