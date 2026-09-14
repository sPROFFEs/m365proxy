import { open, rename, rm, readdir, lstat, unlink, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.mjs';
import { privateDir } from './util.mjs';
import { ProxyError, invalid } from './errors.mjs';

export const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const ALLOWED = new Set(['--port', '--state-dir', '--channel', '--headless', '--model', '--tool-mode', '--strict', '--compat',
  '--workspace', '--workspace-id', '--context-mode', '--context-max-files', '--context-max-file-bytes', '--context-max-bytes',
  '--upload-max-files', '--upload-max-file-size', '--upload-max-bytes', '--upload-timeout-ms', '--upload-ui-config',
  '--timeout-ms', '--first-token-timeout-ms', '--idle-timeout-ms', '--write-mode', '--queue-size', '--queue-timeout-ms',
  '--conversation-mode', '--conversation-ttl-ms', '--conversation-max', '--conversation-max-turns', '--context-policy',
  '--exec-mode', '--exec-max-steps', '--exec-timeout-ms', '--exec-output-bytes']);
const flags = new Set(['--headless', '--strict', '--compat']);

export function validateProfileName(name) {
  if (typeof name !== 'string' || !PROFILE_NAME.test(name) || name === '.' || name === '..')
    throw invalid('Profile name must contain 1-64 letters, digits, dots, underscores or hyphens and start with a letter or digit.');
  return name;
}

export function validateGuidedProfile(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.argv) || raw.argv.length > 96 ||
    Object.keys(raw).some((k) => !['version', 'argv'].includes(k)) ||
    raw.argv.some((s) => typeof s !== 'string' || s.length > 4096 || /[\x00-\x1f\x7f]/.test(s)))
    throw invalid('Invalid saved profile. Configure a new one with m365proxy guided.');
  for (let i = 0; i < raw.argv.length; i++) {
    if (!ALLOWED.has(raw.argv[i])) throw invalid('Unsupported option in saved profile.');
    if (!flags.has(raw.argv[i])) i++;
  }
  readConfig(raw.argv, {});
  return raw.argv;
}

async function safeRead(path) {
  let fd;
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (e.code === 'ENOENT') return null; throw invalid('Cannot safely read saved profile. It must be a private regular file, not a symlink.'); }
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > 16384 || info.nlink !== 1) throw invalid('Invalid saved profile file.');
    const bytes = Buffer.alloc(16385); const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16384) throw invalid('Saved profile is too large.');
    return validateGuidedProfile(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } catch (e) {
    if (e instanceof ProxyError) throw e;
    throw invalid('Saved profile JSON is malformed. Configure it again.');
  } finally { await fd.close(); }
}

async function atomicReplace(path, data) {
  const dir = dirname(path);
  const tmp = join(dir, '.profile-' + randomUUID() + '.tmp');
  try {
    const fd = await open(tmp, 'wx', 0o600);
    try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

export async function loadLegacyGuidedProfile(stateDir) {
  return safeRead(join(stateDir, 'guided.json'));
}
export async function saveLegacyGuidedProfile(stateDir, argv) {
  validateGuidedProfile({ version: 1, argv }); await privateDir(stateDir);
  await atomicReplace(join(stateDir, 'guided.json'), JSON.stringify({ version: 1, argv }, null, 2) + '\n');
}

const profilesDir = (stateDir) => join(stateDir, 'profiles');
const profilePath = (stateDir, name) => join(profilesDir(stateDir), validateProfileName(name) + '.json');

export async function loadNamedProfile(stateDir, name) {
  return safeRead(profilePath(stateDir, name));
}
export async function saveNamedProfile(stateDir, name, argv, { overwrite = false } = {}) {
  validateProfileName(name); validateGuidedProfile({ version: 1, argv }); await privateDir(stateDir);
  const dir = profilesDir(stateDir); await mkdir(dir, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ version: 1, argv }, null, 2) + '\n';
  const path = profilePath(stateDir, name);
  if (!overwrite) {
    try {
      const fd = await open(path, 'wx', 0o600);
      try { await fd.writeFile(payload); await fd.sync(); } finally { await fd.close(); }
    } catch (e) {
      if (e.code === 'EEXIST') throw new ProxyError(409, 'profile_exists', `Profile '${name}' already exists. Choose another name or explicitly edit/replace it.`);
      throw e;
    }
  } else await atomicReplace(path, payload);
  return path;
}
export async function deleteNamedProfile(stateDir, name) {
  const path = profilePath(stateDir, name);
  let info;
  try { info = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw invalid('Refusing to delete an unsafe profile entry.');
  await unlink(path); return true;
}
export async function listNamedProfiles(stateDir) {
  let items;
  try { items = await readdir(profilesDir(stateDir), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const result = [];
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!item.isFile() || !item.name.endsWith('.json')) continue;
    const name = item.name.slice(0, -5);
    if (!PROFILE_NAME.test(name)) continue;
    try {
      const argv = await loadNamedProfile(stateDir, name);
      if (!argv) continue;
      const cfg = readConfig(argv, {});
      result.push({ name, valid: true, argv, port: cfg.port, workspace: cfg.workspaceRoot ?? null, mode: cfg.workspaceRoot ? cfg.contextMode : null,
        write_mode: cfg.writeMode, exec_mode: cfg.execMode, context_policy: cfg.contextPolicy, conversation_mode: cfg.conversationMode });
    } catch (error) { result.push({ name, valid: false, error: error.code ?? 'invalid_profile' }); }
  }
  return result;
}
export async function importLegacyProfile(stateDir, name = 'default') {
  const existing = await listNamedProfiles(stateDir);
  if (existing.length) return false;
  const argv = await loadLegacyGuidedProfile(stateDir);
  if (!argv) return false;
  await saveNamedProfile(stateDir, name, argv, { overwrite: false });
  return true;
}
