import { Worker } from 'node:worker_threads';
import { ProxyError } from './errors.mjs';

// One lazily created, disposable worker per cached Copilot conversation. Real
// upstream code never executes on the HTTP server's event loop. Terminating the
// worker closes its sockets, including transports that ignore AbortSignal.
export class WorkerModelSession {
  constructor({ getToken, maxOutputChars = 1048576, coreModuleUrl } = {}) {
    this.getToken = getToken;
    this.maxOutputChars = maxOutputChars;
    this.coreModuleUrl = coreModuleUrl; // Only injected by offline tests, never HTTP/config.
    this.worker = null;
    this.active = null;
    this.closed = false;
    this.termination = Promise.resolve();
    this.sequence = 0;
  }
  ensureWorker() {
    if (this.closed) throw new ProxyError(502, 'session_closed', 'The upstream session was discarded. Submit a new request.');
    if (this.worker) return;
    const worker = new Worker(new URL('./upstream-worker.mjs', import.meta.url), {
      workerData: { coreModuleUrl: this.coreModuleUrl, maxOutputChars: this.maxOutputChars },
      // Upstream stdout/stderr may contain credential-bearing URLs. Never relay.
      stdout: true, stderr: true,
    });
    this.worker = worker;
    worker.stdout.on('data', () => {});
    worker.stderr.on('data', () => {});
    worker.on('message', (message) => this.onMessage(message));
    worker.on('error', () => {
      this.fail(new ProxyError(502, 'upstream_worker_error', 'The isolated Copilot transport failed. Raw upstream details are suppressed.'));
      this.reset();
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null;
      if (!this.closed) {
        if (this.active) this.fail(new ProxyError(502, 'upstream_worker_exit', 'The isolated Copilot transport exited before completion.'));
        // Never silently recreate a worker while retaining the old history:
        // that would send only a delta to a brand-new remote conversation.
        this.closed = true;
      }
    });
  }
  onMessage(message) {
    const active = this.active;
    if (this.closed) return;
    if (message.type === 'token_request') {
      if (!Number.isInteger(message.runId) || message.runId < 1 || message.runId > this.sequence) return;
      const worker = this.worker;
      // Core may refresh a credential between requests. Respond without
      // starting browser navigation, even when no iterator is currently active.
      Promise.resolve().then(() => { active?.signal?.throwIfAborted(); return this.getToken(); }).then(
        (token) => {
          if (this.worker === worker && !this.closed) worker.postMessage({ type: 'token_result', runId: message.runId, tokenId: message.tokenId, token });
        },
        () => {
          if (this.worker === worker && !this.closed) worker.postMessage({ type: 'token_result', runId: message.runId, tokenId: message.tokenId, error: true });
        },
      ).catch(() => {});
      return;
    }
    if (!active || message.runId !== active.id) return;
    if (message.type === 'started') { active.resolveStart(active.stream); return; }
    if (message.type === 'delta') {
      if (typeof message.text !== 'string' || active.chars + message.text.length > this.maxOutputChars) {
        this.fail(new ProxyError(502, 'output_limit', 'Copilot output exceeded the local size limit.'));
        return;
      }
      active.chars += message.text.length;
      if (!message.text) return;
      if (active.waiter) { const waiter = active.waiter; active.waiter = null; waiter.resolve({ value: message.text, done: false }); }
      else active.queue.push(message.text);
      return;
    }
    if (message.type === 'complete') {
      active.complete = true;
      active.stream.fullText = message.fullText;
      active.stream.messageType = message.messageType;
      active.stream.throttle = message.throttle;
      active.resolveStart(active.stream);
      if (active.waiter) { const waiter = active.waiter; active.waiter = null; this.finishActive(active); waiter.resolve({ done: true }); }
      return;
    }
    if (message.type === 'failed') {
      // Only locally defined, public error codes cross the worker boundary.
      const errors = {
        authentication_required: [428, 'Sign in in the dedicated Copilot browser, send a short message there, then retry.'],
        output_limit: [502, 'Copilot output exceeded the local size limit.'],
        upstream_not_installed: [503, 'The pinned cramt build is missing. Run m365proxy repair.'],
        upstream_error: [502, 'Copilot transport failed. Inspect /health and the request stage; raw upstream details are suppressed.'],
      };
      const code = Object.hasOwn(errors, message.code) ? message.code : 'upstream_error';
      this.fail(new ProxyError(errors[code][0], code, errors[code][1]));
    }
  }
  finishActive(active) {
    active.signal?.removeEventListener('abort', active.abort);
    if (this.active === active) this.active = null;
  }
  fail(error) {
    const active = this.active;
    if (!active) return;
    active.error = error;
    active.rejectStart(error);
    if (active.waiter) { active.waiter.reject(error); active.waiter = null; }
    this.finishActive(active);
    // Release sockets/resources on failures; do not recycle partial sessions.
    this.reset();
  }
  async run(prompt, model, signal) {
    signal?.throwIfAborted();
    if (this.active) throw new ProxyError(429, 'proxy_busy', 'The upstream session already has an active request.');
    this.ensureWorker();
    const active = { id: ++this.sequence, queue: [], chars: 0, complete: false, error: null, waiter: null, signal };
    const started = new Promise((resolve, reject) => { active.resolveStart = resolve; active.rejectStart = reject; });
    active.stream = {
      fullText: '',
      [Symbol.asyncIterator]() { return this; },
      next: () => {
        if (active.error) return Promise.reject(active.error);
        if (active.queue.length) return Promise.resolve({ value: active.queue.shift(), done: false });
        if (active.complete) { this.finishActive(active); return Promise.resolve({ done: true }); }
        return new Promise((resolve, reject) => { active.waiter = { resolve, reject }; });
      },
      return: async () => { this.reset(); return { done: true }; },
    };
    active.abort = () => this.fail(signal.reason ?? new DOMException('Cancelled.', 'AbortError'));
    this.active = active;
    signal?.addEventListener('abort', active.abort, { once: true });
    if (signal?.aborted) active.abort();
    else this.worker.postMessage({ type: 'run', runId: active.id, prompt, model });
    return started;
  }
  reset() {
    if (this.closed) return this.termination;
    this.closed = true;
    if (this.active) {
      const active = this.active;
      active.error ??= new DOMException('Session discarded.', 'AbortError');
      active.rejectStart(active.error);
      active.waiter?.reject(active.error);
      this.finishActive(active);
    }
    const worker = this.worker;
    this.worker = null;
    if (worker) this.termination = worker.terminate().catch(() => {});
    return this.termination;
  }
}
