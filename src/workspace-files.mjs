// Read-only Linux filesystem access. Directory FDs, O_NOFOLLOW and /proc/self/fd
// keep path resolution anchored to the approved tree, including during renames.
// Not a sandbox against a malicious process running as the same OS user.
import { open, realpath, lstat, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { ProxyError } from './errors.mjs';
import { sha256 } from './util.mjs';

const err = (code, message, status = 409) => new ProxyError(status, code, message);
export function validRelative(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 512 &&
    !/[\\\x00-\x1f\x7f:]/.test(path) && !path.startsWith('/') &&
    path.split('/').every((p) => p && p !== '.' && p !== '..');
}
const excluded = new Set(['.git', '.hg', '.svn', '.ssh', '.aws', '.azure', '.gnupg', '.config',
  'node_modules', 'vendor', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.next', '.nuxt', 'dist', 'build', 'target', 'coverage', '.idea', '.vscode',
  'browser-profile', '.m365-copilot-local', '.m365proxy', '.m365proxy-tmp', '.DS_Store']);
export function protectedPath(path) {
  if (!validRelative(path)) return true;
  return path.split('/').some((p) => /^\.m365-edit-tmp-/.test(p) || excluded.has(p) || /^\.env(?:$|[._-])/i.test(p) ||
    /^(?:id_rsa|id_ed25519|id_ecdsa|api[-_]key|process\.(?:lock|guard)|secrets?|credentials?|msal[-_]cache)(?:$|[._-])/i.test(p) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|sqlite3?|db|log|zip|tgz|gz|7z|rar|exe|dll|so|o|pyc)$/i.test(p) ||
    /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock)$/.test(p));
}
const sourceExtensions = new Set(('.js .mjs .cjs .jsx .ts .tsx .py .go .rs .c .h .cc .cpp .hpp .java .kt .kts .cs .fs .rb .php .swift .dart .lua .pl .r .R .sh .bash .zsh .fish .ps1 .bat .cmd .json .yaml .yml .toml .ini .cfg .conf .xml .html .htm .css .scss .sass .less .vue .svelte .sql .graphql .proto .md .mdx .rst .txt .tex .cmake .gradle .properties .dockerfile .mod').split(' '));
export function sourcePath(path) {
  const name = basename(path);
  return !protectedPath(path) && (sourceExtensions.has(extname(name)) || /^(?:Dockerfile|Containerfile|Makefile|CMakeLists\.txt|Gemfile|Rakefile|Justfile|LICENSE|NOTICE)$/i.test(name));
}
export function containsSecret(text) {
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text) ||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,})\b/.test(text) ||
    /(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[=:]\s*["'][^"'\n]{8,}["']/i.test(text);
}
export function textBytes(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? null : text;
}

export class SafeTree {
  static async create(root, { stateDir } = {}) {
    if (process.platform !== 'linux') throw err('workspace_platform', 'Workspace context currently requires Linux and /proc/self/fd.', 400);
    const canonical = await realpath(resolve(root));
    if ([resolve(homedir()), '/', '/proc', '/sys', '/dev', '/etc'].includes(canonical) || /^\/(?:proc|sys|dev)(?:\/|$)/.test(canonical))
      throw err('workspace_root_denied', 'Select a project folder, not your home, filesystem root or a system tree.', 400);
    const stat = await lstat(canonical);
    if (!stat.isDirectory()) throw err('workspace_not_directory', 'Workspace root must be a directory.', 400);
    const excludedRoot = stateDir ? await realpath(resolve(stateDir)).catch(() => resolve(stateDir)) : null;
    if (excludedRoot && (canonical === excludedRoot || canonical.startsWith(excludedRoot + '/')))
      throw err('workspace_root_denied', 'The proxy state/profile cannot be used as a workspace.', 400);
    return new SafeTree(canonical, stat, excludedRoot);
  }
  constructor(root, stat, excludedRoot) {
    this.root = root; this.dev = stat.dev; this.ino = stat.ino; this.excludedRoot = excludedRoot;
  }
  allowed(path) {
    return !protectedPath(path) && !(this.excludedRoot &&
      (this.root + '/' + path === this.excludedRoot || (this.root + '/' + path).startsWith(this.excludedRoot + '/')));
  }
  async withRoot(action) {
    const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.dev !== this.dev || stat.ino !== this.ino) throw err('workspace_root_changed', 'The project directory was replaced. Restart with the intended root.');
      return await action(handle);
    } finally { await handle.close(); }
  }
  async read(path, maxBytes = 32768, { internal = false, signal } = {}) {
    signal?.throwIfAborted();
    if (!validRelative(path) || (!internal && !this.allowed(path))) throw err('workspace_path_denied', 'File path is outside the approved source policy.', 400);
    return this.withRoot(async (root) => {
      const dirs = [], parts = path.split('/'); let parent = root;
      try {
        for (const part of parts.slice(0, -1)) {
          const dir = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          dirs.push(dir); parent = dir;
        }
        const file = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const before = await file.stat({ bigint: true });
          if (!before.isFile() || before.nlink !== 1n) throw err('workspace_special_file', 'Symlinks, hard links and special files are not included.');
          if (before.size > BigInt(maxBytes)) throw err('workspace_file_size', 'File exceeds the context per-file limit.');
          const buffer = Buffer.alloc(Number(before.size) + 1); let used = 0;
          while (used < buffer.length) {
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
            if (!bytesRead) break; used += bytesRead;
          }
          const after = await file.stat({ bigint: true });
          if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || used !== Number(before.size))
            throw err('workspace_changed', 'A source file changed during snapshot construction. Retry after saving.');
          const bytes = buffer.subarray(0, used), text = textBytes(bytes);
          if (text === null) throw err('workspace_binary', 'Non-UTF-8 or binary content was excluded.');
          if (!internal && containsSecret(text)) throw err('workspace_secret', 'A source file matched the secret heuristic and was excluded.');
          return { path, text, bytes: used, sha256: sha256(bytes) };
        } finally { await file.close(); }
      } finally { for (const dir of dirs.reverse()) await dir.close(); }
    });
  }
  async names(path = '', limit = 5000) {
    if (path && (!validRelative(path) || !this.allowed(path))) return [];
    return this.withRoot(async (root) => {
      const dirs = []; let dir = root;
      try {
        for (const part of path ? path.split('/') : []) {
          dir = await open(`/proc/self/fd/${dir.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          dirs.push(dir);
        }
        const entries = []; let truncated = false;
        const stream = await opendir(`/proc/self/fd/${dir.fd}`);
        for await (const entry of stream) {
          if (entries.length >= limit) { truncated = true; break; }
          entries.push(entry);
        }
        entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
        entries.truncated = truncated; return entries;
      } finally { for (const handle of dirs.reverse()) await handle.close(); }
    });
  }
}

// Gitignore-style rules: anchored/slash patterns, *, **, ?, [] classes, escaped
// characters, negation and nested files. Ignored parents are never traversed.
// Unsupported/malformed syntax fails closed instead of silently including files.
function globRegex(pattern) {
  // Memoized glob matching, not user-controlled backtracking regular expressions.
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      if (++i >= pattern.length) throw err('workspace_ignore_pattern', 'Trailing escape in ignore rules.', 400);
      tokens.push({ kind: 'char', value: pattern[i] });
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        const beginsComponent = i === 0 || pattern[i - 1] === '/';
        while (pattern[i + 1] === '*') i++;
        if (beginsComponent && pattern[i + 1] === '/') { i++; tokens.push({ kind: 'dirs' }); }
        else tokens.push({ kind: beginsComponent && i + 1 === pattern.length ? 'all' : 'star' });
      } else tokens.push({ kind: 'star' });
    } else if (c === '?') tokens.push({ kind: 'one' });
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0 || pattern.slice(i, end + 1).includes('[:')) throw err('workspace_ignore_pattern', 'Unsupported character class in ignore rules.', 400);
      let inner = pattern.slice(i + 1, end); if (inner.startsWith('!')) inner = '^' + inner.slice(1);
      if (!inner || inner.includes('/') || inner.includes('\\')) throw err('workspace_ignore_pattern', 'Unsupported character class in ignore rules.', 400);
      try { tokens.push({ kind: 'class', regex: new RegExp('^[' + inner + ']$') }); }
      catch { throw err('workspace_ignore_pattern', 'Invalid character class in ignore rules.', 400); }
      i = end;
    } else tokens.push({ kind: 'char', value: c });
  }
  return { test(input) {
    const memo = new Map();
    const match = (i, j) => {
      const key = i * (input.length + 1) + j;
      if (memo.has(key)) return memo.get(key);
      let ok = false;
      if (i === tokens.length) ok = j === input.length;
      else {
        const token = tokens[i], value = input[j];
        if (token.kind === 'char') ok = value === token.value && match(i + 1, j + 1);
        else if (token.kind === 'one' || token.kind === 'class') ok = j < input.length && value !== '/' && (token.kind === 'one' || token.regex.test(value)) && match(i + 1, j + 1);
        else if (token.kind === 'dirs') {
          ok = match(i + 1, j);
          for (let k = j; !ok && k < input.length; k++) if (input[k] === '/') ok = match(i + 1, k + 1);
        } else ok = match(i + 1, j) || (j < input.length && (token.kind === 'all' || value !== '/') && match(i, j + 1));
      }
      memo.set(key, ok); return ok;
    };
    return match(0, 0);
  } };
}

export function parseIgnore(text, base = '') {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    // Unescaped trailing spaces are ignored; escaped spaces remain significant.
    line = line.replace(/(?<!\\) +$/, '');
    if (!line || line.startsWith('#')) continue;
    if (line.length > 512 || rules.length >= 1000) throw err('workspace_ignore_limit', 'Ignore rules exceed the bounded parser limit.', 400);
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    const dir = line.endsWith('/'); if (dir) line = line.slice(0, -1);
    const anchored = line.startsWith('/'); if (anchored) line = line.slice(1);
    if (!line || /[\x00-\x1f\x7f]/.test(line)) throw err('workspace_ignore_pattern', 'Invalid ignore pattern.', 400);
    rules.push({ base, negate, dir, simple: !anchored && !line.includes('/'), regex: globRegex(line) });
  }
  return rules;
}
export function ignored(path, isDir, rules) {
  let ignore = false;
  for (const rule of rules) {
    if (rule.base && !path.startsWith(rule.base + '/')) continue;
    const rel = rule.base ? path.slice(rule.base.length + 1) : path;
    if (rule.dir && !isDir) continue;
    if (rule.regex.test(rule.simple ? basename(rel) : rel)) ignore = !rule.negate;
  }
  return ignore;
}
