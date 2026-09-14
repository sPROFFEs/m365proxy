// AbortSignal is only a notification. Race every asynchronous boundary as well,
// so an upstream Promise/iterator that ignores it cannot hold the local request.
export function abortable(task, signal, onLateValue) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => { if (!done) { done = true; cleanup(); reject(signal.reason); } };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    Promise.resolve().then(() => { signal?.throwIfAborted(); return task(); }).then(
      (value) => {
        if (done) { try { Promise.resolve(onLateValue?.(value)).catch(() => {}); } catch {} return; }
        done = true; cleanup(); resolve(value);
      },
      (error) => { if (!done) { done = true; cleanup(); reject(error); } },
    );
  });
}

// Cleanup must never become a second unbounded wait or an unhandled rejection.
export function detachCleanup(task) {
  try { Promise.resolve(task()).catch(() => {}); } catch {}
}
