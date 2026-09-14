// Idempotent, backed-up PATH integration for Bash and Zsh. No shell execution.
import { lstat, realpath, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const begin = '# >>> m365proxy PATH >>>';
const end = '# <<< m365proxy PATH <<<';
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
async function existing(path) { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export function stripBlock(text) {
  const starts = text.split(begin).length - 1, ends = text.split(end).length - 1;
  if (starts !== ends || starts > 1) throw new Error('Unexpected PATH markers; inspect your shell config before retrying.');
  if (starts === 0) return text;
  const stripped = text.replace(/^# >>> m365proxy PATH >>>\r?\n[\s\S]*?^# <<< m365proxy PATH <<<\r?\n?/m, '');
  if (stripped === text) throw new Error('PATH markers must be standalone lines.');
  return stripped;
}
export function pathBlock(bin) {
  if (!isAbsolute(bin) || /[\r\n:]/.test(bin)) throw new Error('An absolute bin path without line breaks is required.');
  return `${begin}\n_m365proxy_bin=${quote(bin)}\ncase ":\${PATH-}:" in\n  *":\${_m365proxy_bin}:"*) ;;\n  *) export PATH="\${_m365proxy_bin}:\${PATH-}" ;;\nesac\nunset _m365proxy_bin\n${end}\n`;
}
async function main() {
  const [action, bin] = process.argv.slice(2);
  if (!['add', 'remove'].includes(action) || (action === 'add' && !bin)) throw new Error('Usage: linux-path.mjs add BIN_DIR | remove');
  const home = homedir();
  const zhome = process.env.ZDOTDIR || home;
  if (!isAbsolute(zhome)) throw new Error('ZDOTDIR must be absolute.');
  const paths = [join(home, '.profile'), join(home, '.bashrc'), join(zhome, '.zshrc')];
  for (const name of ['.bash_profile', '.bash_login']) {
    const file = join(home, name);
    if (await existing(file)) { paths.push(file); break; }
  }
  const pending = [], seen = new Set();
  for (let path of paths) {
    let stat = await existing(path);
    if (stat?.isSymbolicLink()) { path = await realpath(path); stat = await lstat(path); }
    if (seen.has(path)) continue;
    seen.add(path);
    if (stat && !stat.isFile()) throw new Error(`Not a regular shell configuration file: ${path}`);
    if (!stat && action === 'remove') continue;
    const before = stat ? await readFile(path, 'utf8') : '';
    const stripped = stripBlock(before);
    // Do not grow blank lines on repeat installs.
    const after = action === 'add' ? stripped.replace(/\n*$/, '') + (stripped.trim() ? '\n\n' : '') + pathBlock(bin) : stripped;
    if (after !== before) pending.push({ path, stat, before, after });
  }
  for (const { path, stat, before, after } of pending) {
    await mkdir(dirname(path), { recursive: true });
    const nonce = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    if (stat) await writeFile(`${path}.m365proxy-backup-${nonce}`, before, { mode: 0o600, flag: 'wx' });
    const tmp = `${path}.m365proxy-tmp-${nonce}`;
    await writeFile(tmp, after, { mode: stat ? stat.mode & 0o777 : 0o600, flag: 'wx' });
    await rename(tmp, path);
    console.log(`PATH ${action}: ${path}${stat ? ' (original backed up)' : ''}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`PATH integration failed: ${e.message}`); process.exitCode = 1; });
}
