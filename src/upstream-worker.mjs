import { parentPort, workerData } from 'node:worker_threads';
import { loadCore } from './core-loader.mjs';
import { ProxyError, publicError } from './errors.mjs';

let backend, running = false, tokenSequence = 0, currentRunId;
const pendingTokens = new Map();
const corePromise = workerData.coreModuleUrl ? import(workerData.coreModuleUrl) : loadCore();
// Prevent an unhandled rejection before the first run message arrives.
corePromise.catch(() => {});

parentPort.on('message', async (message) => {
  if (message.type === 'token_result') {
    const pending = pendingTokens.get(message.tokenId);
    if (!pending || pending.runId !== message.runId) return;
    pendingTokens.delete(message.tokenId);
    if (message.error || typeof message.token !== 'string') pending.reject(new ProxyError(428, 'authentication_required', 'Browser authentication is required.'));
    else pending.resolve(message.token);
    return;
  }
  if (message.type !== 'run' || running) return;
  running = true;
  const runId = message.runId; currentRunId = runId;
  const send = (payload) => parentPort.postMessage({ ...payload, runId });
  try {
    const core = await corePromise;
    backend ??= new core.ModelSession({
      useAgent: false,
      getToken: () => new Promise((resolve, reject) => {
        const tokenId = ++tokenSequence;
        pendingTokens.set(tokenId, { runId: currentRunId, resolve, reject });
        parentPort.postMessage({ type: 'token_request', tokenId, runId: currentRunId });
      }),
    });
    // Cancellation is enforced by terminating this worker, not by trusting this
    // upstream signal to interrupt every HTTP/WebSocket/iterator operation.
    const controller = new AbortController();
    const stream = await backend.run(message.prompt, message.model, controller.signal, false);
    send({ type: 'started' });
    let chars = 0;
    for await (const text of stream) {
      if (typeof text !== 'string') throw new Error('Invalid upstream fragment.');
      chars += text.length;
      if (chars > workerData.maxOutputChars) throw new ProxyError(502, 'output_limit', 'Output limit exceeded.');
      if (text) send({ type: 'delta', text });
    }
    const fullText = typeof stream.fullText === 'string' ? stream.fullText : '';
    if (fullText.length > workerData.maxOutputChars) throw new ProxyError(502, 'output_limit', 'Output limit exceeded.');
    send({ type: 'complete', fullText, messageType: typeof stream.messageType === 'string' ? stream.messageType : '',
      throttle: stream.throttle && Number.isFinite(stream.throttle.current) && Number.isFinite(stream.throttle.max)
        ? { current: stream.throttle.current, max: stream.throttle.max } : null });
  } catch (error) {
    send({ type: 'failed', code: publicError(error).code });
  } finally {
    running = false;
  }
});
