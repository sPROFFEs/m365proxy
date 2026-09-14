import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const plainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export function stable(x) {
  if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
  if (plainObject(x)) return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('State path must be a real directory, not a symlink.');
  if (process.platform !== 'win32') await chmod(path, 0o700);
}
export async function getApiKey(dir) {
  await privateDir(dir);
  const path = join(dir, 'api-key');
  try {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(randomBytes(32).toString('hex') + '\n'); }
    finally { await handle.close(); }
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('API key must be a regular file.');
  if (process.platform !== 'win32') await chmod(path, 0o600);
  const key = (await readFile(path, 'utf8')).trim();
  if (key.length < 32 || key.length > 256) throw new Error('Invalid local API key file.');
  return key;
}
export { acquireLock } from './process-lock.mjs';
export function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(signal.reason); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
