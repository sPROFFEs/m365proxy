import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function run(command, args, { cwd, quiet = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false });
    let out = '', err = '';
    child.stdout?.on('data', (data) => { out += data; });
    child.stderr?.on('data', (data) => { err += data; });
    child.once('error', () => reject(new Error(`Cannot start ${command}. Check that it is installed.`)));
    child.once('exit', (code) => code === 0 ? resolvePromise(out.trim()) : reject(new Error(`${command} exited with code ${code}.${quiet && err ? '\n' + err.slice(0, 2000) : ''}`)));
  });
}
export function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'].filter(Boolean);
  const result = candidates.find((p) => existsSync(p) && /npm-cli\.js$/.test(p));
  if (!result) throw new Error('Cannot locate npm-cli.js. Invoke this script through npm run setup.');
  return result;
}
export function pnpm(args, cwd) {
  return run(process.execPath, [npmCli(), 'exec', '--yes', '--package=pnpm@10.32.1', '--', 'pnpm', ...args], { cwd });
}
