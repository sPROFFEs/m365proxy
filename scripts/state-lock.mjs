// Installer helper: hold the exact same kernel/profile lock as the service.
// READY is a machine-readable handshake; stderr never contains credentials.
// Stdin EOF (including installer death) releases the guard and PID metadata.
import { acquireLock } from '../src/util.mjs';
const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
let release;
try {
  release = await acquireLock(process.argv[2], { signal: controller.signal,
    onRecovery: ({ pid }) => console.error(`[LOCK] Recovered stale process.lock for PID ${pid}.`) });
  console.log('READY');
  await new Promise((resolve) => {
    process.stdin.on('end', resolve); process.stdin.on('error', resolve); process.stdin.resume();
    controller.signal.addEventListener('abort', resolve, { once: true });
    if (controller.signal.aborted) resolve();
  });
} catch (error) {
  if (error?.name !== 'AbortError') { console.error(`[LOCK] ${error.code ?? 'lock_error'}: ${error.message}`); process.exitCode = 1; }
} finally {
  try { await release?.(); }
  finally { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop); process.stdin.destroy(); }
}
