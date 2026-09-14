// FIFO admission only: one active browser/worker turn. Pending requests have a
// separate bounded wait and are removed on disconnect; no upstream auto replay.
import { ProxyError } from './errors.mjs';
export class RequestQueue {
  constructor({ maxPending = 4, waitMs = 240000 } = {}) {
    this.maxPending = maxPending; this.waitMs = waitMs; this.pending = []; this.active = false; this.closed = false;
  }
  acquire({ signal, onWait = () => {} } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new ProxyError(503, 'proxy_stopping', 'The proxy is stopping.'));
    if (!this.active) { this.active = true; return Promise.resolve(this.releaseHandle()); }
    if (this.pending.length >= this.maxPending) return Promise.reject(new ProxyError(429, this.maxPending ? 'queue_full' : 'proxy_busy',
      this.maxPending ? 'The bounded request queue is full. Wait before sending more requests.' : 'This single-user proxy is handling another request and queuing is disabled.'));
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, signal };
      const remove = (error) => { const i = this.pending.indexOf(item); if (i < 0) return; this.pending.splice(i, 1); item.cleanup(); reject(error); };
      const abort = () => remove(signal.reason);
      const timer = setTimeout(() => remove(new ProxyError(408, 'queue_timeout', 'The request expired while queued. It was not sent to Microsoft.')), this.waitMs);
      item.cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.push(item); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else onWait(this.pending.length);
    });
  }
  releaseHandle() {
    let released = false;
    return () => {
      if (released) return; released = true;
      const next = this.pending.shift();
      if (next) { next.cleanup(); next.resolve(this.releaseHandle()); }
      else this.active = false;
    };
  }
  close() {
    this.closed = true;
    for (const item of this.pending.splice(0)) { item.cleanup(); item.reject(new ProxyError(503, 'proxy_stopping', 'The proxy stopped before this queued request ran.')); }
  }
  status() { return { pending: this.pending.length, max_pending: this.maxPending, wait_timeout_ms: this.waitMs }; }
}
