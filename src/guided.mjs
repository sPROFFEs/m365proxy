// Interactive terminal setup. Saved named profiles contain validated argv only;
// no passwords, Microsoft tokens or local API keys are persisted in them.
import { createInterface } from 'node:readline/promises';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { readConfig } from './config.mjs';
import { getApiKey } from './util.mjs';
import { ProxyError, invalid } from './errors.mjs';
import { WorkspaceManager } from './workspace.mjs';
import { isUploadMode } from './upload-manifest.mjs';
import { changeCommand } from './change-cli.mjs';
import { diagnose } from './diagnostics.mjs';
import {
  validateGuidedProfile, loadLegacyGuidedProfile, saveLegacyGuidedProfile,
  validateProfileName, loadNamedProfile, saveNamedProfile, deleteNamedProfile,
  listNamedProfiles, importLegacyProfile,
} from './profile-store.mjs';

// Backward-compatible exports for callers/tests that used the single-profile API.
export { validateGuidedProfile };
export const loadGuidedProfile = loadLegacyGuidedProfile;
export const saveGuidedProfile = saveLegacyGuidedProfile;

export function terminalIO(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new ProxyError(400, 'guided_terminal_required', 'menu/guided needs an interactive terminal. Do not pipe answers; use explicit CLI flags for scripts.');
  const abort = new AbortController(), rl = createInterface({ input, output });
  rl.on('SIGINT', () => { abort.abort(new DOMException('Cancelled.', 'AbortError')); rl.close(); });
  rl.on('close', () => { if (!abort.signal.aborted) abort.abort(new DOMException('Terminal closed.', 'AbortError')); });
  return { ask: (text) => rl.question(text, { signal: abort.signal }), write: (text) => output.write(text + '\n'), close: () => rl.close() };
}
async function answer(io, question, fallback = '') {
  const value = (await io.ask(`${question}${fallback !== '' ? ' [' + fallback + ']' : ''}: `)).trim();
  if (/[\x00-\x1f\x7f]/.test(value)) throw invalid('Control characters are not allowed in guided answers.');
  return value || String(fallback);
}
async function yes(io, question, fallback = false) {
  for (;;) {
    const value = (await answer(io, question + ' (y/n)', fallback ? 'y' : 'n')).toLowerCase();
    if (['y', 'yes', 's', 'si', 'sí'].includes(value)) return true;
    if (['n', 'no'].includes(value)) return false;
    io.write('Type y or n.');
  }
}
async function integer(io, question, fallback, min, max) {
  for (;;) {
    const value = Number(await answer(io, question, fallback));
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    io.write(`Use an integer between ${min} and ${max}.`);
  }
}
const expanded = (path) => resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
const shellQuote = (s) => /^[a-zA-Z0-9_./:-]+$/.test(String(s)) ? String(s) : "'" + String(s).replaceAll("'", "'\\''") + "'";

const RULE = '='.repeat(72);
const SUBRULE = '-'.repeat(72);
function banner(io, title, subtitle = '') {
  io.write('');
  io.write(RULE);
  io.write(` ${title}`);
  if (subtitle) io.write(` ${subtitle}`);
  io.write(RULE);
}
function section(io, current, total, title, lines = []) {
  io.write('');
  io.write(`[${current}/${total}] ${title}`);
  io.write(SUBRULE);
  for (const line of lines) io.write(line);
}
function menuGroup(io, title, items) {
  io.write('');
  io.write(`-- ${title} ${'-'.repeat(Math.max(1, 67 - title.length))}`);
  for (const item of items) io.write(item);
}
function valueLabel(value, fallback = '-') { return value === undefined || value === null || value === '' ? fallback : String(value); }

const suggestedProfile = (base, cwd) => {
  const raw = basename(base.workspaceRoot ?? cwd ?? 'default').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 48);
  return raw || 'default';
};

export function showConnection(config, io) {
  io.write('');
  io.write('CONNECTION AND PROFILE MODES');
  io.write(SUBRULE);
  io.write(`  Base URL       : http://127.0.0.1:${config.port}/v1`);
  io.write(`  Model          : ${config.defaultModel}`);
  io.write(`  Profile        : ${config.execMode === 'script' ? 'FULL WORKSPACE' : config.workspaceRoot ? 'WORKSPACE CONTEXT' : 'CHAT ONLY'}`);
  io.write(`  Workspace      : ${valueLabel(config.workspaceRoot, 'none')}`);
  io.write(`  Context        : ${config.workspaceRoot ? `${config.contextMode}/${config.contextPolicy ?? 'adaptive'}` : 'off'}`);
  io.write(`  Conversation   : ${config.conversationMode ?? 'reuse'}`);
  io.write(`  AUTO-WRITE     : ${config.writeMode === 'auto' ? 'ACTIVE' : 'off'}`);
  io.write(`  EXEC SCRIPT    : ${config.execMode === 'script' ? 'ACTIVE [EXPERIMENTAL]' : 'off'}`);
  io.write(`  Queue          : ${config.queueMaxPending ?? 4} max pending.`);
  io.write('');
  io.write(`  API key        : m365proxy key --state-dir ${shellQuote(config.stateDir)}`);
  io.write(`  Status         : m365proxy status --port ${config.port} --state-dir ${shellQuote(config.stateDir)}`);
  io.write(SUBRULE);
  io.write('PrAImate/OpenClaude/OpenCode should use the Base URL above. Workspace folders chosen in a GUI client DO NOT change the proxy workspace root.');
}
async function preview(config, io) {
  if (!config.workspaceRoot) { io.write('No workspace folder configured.'); return; }
  const manager = await WorkspaceManager.fromConfig(config);
  try {
    const query = await answer(io, 'Query/keywords to preview selection', '');
    const snapshot = await manager.snapshot(undefined, query, { localExec: config.execMode === 'script' });
    io.write('');
    io.write('LOCAL PREVIEW - nothing sent to Microsoft');
    io.write(SUBRULE);
    io.write(`Decision       : ${snapshot.summary.context_decision}`);
    io.write(`Policy         : ${snapshot.summary.context_policy}`);
    io.write(`Selected files : ${snapshot.selected.length}`);
    if (snapshot.summary.selected_files.length) {
      io.write('Files:');
      for (const f of snapshot.summary.selected_files) io.write(`  - ${f.path} (${f.bytes} bytes)${f.attachment_name ? ' -> ' + f.attachment_name : ''}`);
    } else io.write('Files          : none selected for this query');
    io.write(`Exclusions     : ${JSON.stringify(snapshot.summary.skipped)}`);
    io.write(SUBRULE);
    io.write('Adaptive policy may select 0 attachments for general questions or local actions. Always keeps context attached on every turn.');
    return snapshot;
  } finally { await manager.close?.(); }
}
async function namedProfiles(stateDir) {
  await importLegacyProfile(stateDir).catch(() => false);
  return listNamedProfiles(stateDir);
}
async function chooseProfile(io, stateDir, question = 'Profile') {
  const profiles = (await namedProfiles(stateDir)).filter((p) => p.valid);
  if (!profiles.length) { io.write('No saved profiles found. Create one first.'); return null; }
  io.write('');
  io.write('SAVED PROFILES');
  io.write(SUBRULE);
  profiles.forEach((p, i) => {
    const action = p.exec_mode === 'script' ? 'EXEC[EXP]' : p.write_mode === 'auto' ? 'AUTO-WRITE' : 'OFF';
    const workspace = p.workspace ? `${p.mode}/${p.context_policy ?? 'adaptive'} | ${p.workspace}` : 'no workspace';
    io.write(`  [${i + 1}] ${p.name}`);
    io.write(`      API : 127.0.0.1:${p.port} | chat ${p.conversation_mode} | actions ${action}`);
    io.write(`      WS  : ${workspace}`);
  });
  io.write(SUBRULE);
  const idx = await integer(io, question, 1, 1, profiles.length);
  const chosen = profiles[idx - 1];
  return { ...chosen, config: readConfig(chosen.argv, {}) };
}

async function configureAdvancedGuided(base, io, {
  persist = saveNamedProfile, profileName, overwrite = false, cwd = process.cwd(), askProfileName = true,
} = {}) {
  let name = profileName;
  if (!name && askProfileName) name = validateProfileName(await answer(io, 'Name for this profile', suggestedProfile(base, cwd)));
  if (name) {
    const exists = await loadNamedProfile(base.stateDir, name).catch(() => null);
    if (exists && !overwrite) throw new ProxyError(409, 'profile_exists', `Profile '${name}' already exists. Edit it from the menu or use a different name; not overwritten.`);
  }

  banner(io, 'M365PROXY - GUIDED CONFIGURATION', `Profile: ${name ?? '(unsaved)'}`);
  io.write('Each section configures an independent aspect. Press Enter to accept default values in brackets.');
  io.write('IMPORTANT: AUTO-WRITE and EXEC SCRIPT are mutually exclusive. The wizard will always show both options when a workspace is chosen.');

  section(io, 1, 8, 'Local API & Browser', [
    'Configure the local proxy port and the browser used to host the Microsoft Copilot session.',
    'Playwright Chromium is the recommended choice.',
  ]);
  const port = await integer(io, 'Local port', base.port, 1, 65535);
  io.write('  1 Playwright Chromium (recommended)');
  io.write('  2 Installed Microsoft Edge');
  io.write('  3 Installed Google Chrome');
  const channelIndex = ['chromium', 'msedge', 'chrome'].indexOf(base.channel) + 1;
  const channel = ['chromium', 'msedge', 'chrome'][(await integer(io, 'Browser', channelIndex || 1, 1, 3)) - 1];
  const headless = await yes(io, 'Headless browser (only if sign-in is already complete)', false);

  section(io, 2, 8, 'Workspace & Context', [
    'The workspace is the local folder the proxy can read or modify.',
    'Adaptive policy avoids attaching files for general questions; Always attaches context every turn.',
  ]);
  io.write('  1 No workspace: classic chat proxy');
  io.write('  2 read   : selected code injected into prompt');
  io.write('  3 hybrid : attachments + file manifest (experimental)');
  io.write('  4 upload : attachments + minimal manifest (experimental)');
  io.write('  5 patch  : proposes diffs; does not apply changes');
  const modes = ['', 'read', 'hybrid', 'upload', 'patch'];
  const defaultMode = base.workspaceRoot ? Math.max(1, modes.indexOf(base.contextMode) + 1) : 1;
  const mode = modes[(await integer(io, 'Context mode', defaultMode, 1, 5)) - 1];
  const args = ['--port', String(port), '--state-dir', base.stateDir, '--channel', channel];
  if (headless) args.push('--headless');
  let folder, contextPolicy = base.contextPolicy ?? 'adaptive';
  if (mode) {
    folder = expanded(await answer(io, 'Workspace directory', base.workspaceRoot ?? cwd));
    args.push('--workspace', folder, '--context-mode', mode);
    io.write('');
    io.write('Context policy:');
    io.write('  1 adaptive (recommended: sends 0 files when unneeded)');
    io.write('  2 always   (attaches context on every turn)');
    contextPolicy = (await integer(io, 'Policy', base.contextPolicy === 'always' ? 2 : 1, 1, 2)) === 2 ? 'always' : 'adaptive';
    args.push('--context-policy', contextPolicy);
  } else {
    io.write('No workspace: local reading, auto-write, and script execution are disabled.');
  }

  section(io, 3, 8, 'Copilot Chat Continuity', [
    'reuse keeps the persistent Copilot tab/chat across turns to avoid creating a new remote conversation per request.',
    'fresh creates a brand new remote chat for every request.',
  ]);
  io.write('  1 reuse (recommended)');
  io.write('  2 fresh');
  const conversation = (await integer(io, 'Conversation mode', base.conversationMode === 'fresh' ? 2 : 1, 1, 2)) === 1 ? 'reuse' : 'fresh';
  args.push('--conversation-mode', conversation);
  if (conversation === 'reuse') io.write('reuse automatically rotates on TTL/turn limits and uses sticky fallback when client history is rewritten.');

  section(io, 4, 8, 'Local Actions: Choose ONE Controller', [
    'Determines whether the proxy can modify files or execute scripts on the host.',
    'AUTO-WRITE and EXEC SCRIPT cannot be active simultaneously to prevent competing workspace modifications.',
  ]);
  let autoSave = false, execMode = 'off';
  if (folder && mode !== 'patch') {
    io.write('  1 OFF              : context/chat only; no writes or execution');
    io.write('  2 AUTO-WRITE       : saves file changes with backups; DOES NOT run commands');
    io.write('  3 EXEC SCRIPT [EXP]: Copilot proposes temporary scripts and proxy executes them without per-command prompt');
    const defaultAction = base.execMode === 'script' ? 3 : base.writeMode === 'auto' ? 2 : 1;
    const actionMode = await integer(io, 'Local action mode', defaultAction, 1, 3);
    autoSave = actionMode === 2;
    execMode = actionMode === 3 ? 'script' : 'off';
    args.push('--write-mode', autoSave ? 'auto' : 'off', '--exec-mode', execMode);
    if (autoSave) {
      io.write('');
      io.write('AUTO-WRITE ACTIVATED');
      io.write('  - Can create/modify/delete files inside the workspace.');
      io.write('  - Keeps local backups and change receipts.');
      io.write('  - Does not execute shell, Python, or PowerShell commands.');
      io.write('  - EXEC SCRIPT is OFF in this profile.');
    } else if (execMode === 'script') {
      io.write('');
      io.write('EXEC SCRIPT EXPERIMENTAL ACTIVATED');
      io.write('  - Copilot can propose bash/sh/python/PowerShell/cmd scripts.');
      io.write('  - The proxy executes them without per-command prompts under the proxy user privileges.');
      io.write('  - Temporary scripts reside in .m365proxy-tmp and are cleaned up after completion.');
      io.write('  - Not a sandbox. AUTO-WRITE is OFF in this profile.');
      const maxSteps = await integer(io, 'Max scripts per request', base.execMaxSteps ?? 4, 1, 8);
      const stepTimeout = await integer(io, 'Per-script timeout (ms)', base.execTimeoutMs ?? 30000, 1000, 120000);
      args.push('--exec-max-steps', String(maxSteps), '--exec-timeout-ms', String(stepTimeout));
    } else {
      io.write('Local actions disabled.');
    }
  } else {
    args.push('--write-mode', 'off', '--exec-mode', 'off');
    if (mode === 'patch') io.write('Patch mode: local actions forced to OFF; generates proposals only.');
    else io.write('No workspace: local actions unavailable.');
  }

  section(io, 5, 8, 'Client Tool Call Compatibility', [
    'guarded adds delimiters and strict schema validation; cramt uses format compatible with original core.',
    'If AUTO-WRITE or EXEC SCRIPT are active, client tools are suppressed so the proxy acts as sole controller.',
  ]);
  io.write('  1 guarded (recommended)');
  io.write('  2 cramt');
  const tool = await integer(io, 'Tool format', base.toolMode === 'cramt' ? 2 : 1, 1, 2);
  args.push('--tool-mode', tool === 2 ? 'cramt' : 'guarded');

  section(io, 6, 8, 'Upload Settings', [
    isUploadMode(mode)
      ? 'Copilot allows up to 3 attachments per message. The proxy splits larger selections into batches of <=3 within the SAME chat.'
      : 'This profile does not use web uploader; no settings required here.',
  ]);
  if (isUploadMode(mode)) {
    io.write('Uploaded files are sent to Microsoft storage and may remain in OneDrive.');
    io.write('With reuse, unchanged files are reused across turns without re-uploading.');
    const maxFiles = await integer(io, 'Max selected files per request', base.uploadMaxFiles ?? 5, 1, 20);
    args.push('--upload-max-files', String(maxFiles), '--timeout-ms', execMode === 'script' ? '300000' : '240000');
    if (await yes(io, 'Configure custom selectors for a different UI locale/layout', false)) {
      const file = expanded(await answer(io, 'Path to selectors JSON config'));
      const { loadUploadUI } = await import('./browser-upload.mjs'); await loadUploadUI(file);
      args.push('--upload-ui-config', file);
    }
  }

  const config = readConfig(args, {});

  section(io, 7, 8, 'Preview & Confirmation', [
    'Preview is local: does not launch browser or send data to Microsoft.',
  ]);
  if (folder) {
    const snapshot = await preview(config, io);
    if (!snapshot.selected.length && config.writeMode !== 'auto' && config.execMode !== 'script' && !snapshot.allowEmpty) {
      io.write('No files selected. Adjust folder path or .m365ignore and reconfigure; nothing was saved or started.');
      return null;
    }
    if (!await yes(io, 'Authorize this profile to send selected workspace context to Microsoft', false)) {
      io.write('Cancelled: profile was not saved and proxy was not started.'); return null;
    }
  }

  banner(io, 'PROFILE SUMMARY', name ? `Name: ${name}` : 'Unsaved');
  io.write(`Local API       : http://127.0.0.1:${config.port}/v1`);
  io.write(`Browser         : ${config.channel}${config.headless ? ' (headless)' : ' (visible)'}`);
  io.write(`Workspace       : ${valueLabel(config.workspaceRoot, 'none')}`);
  io.write(`Context         : ${folder ? `${config.contextMode} / ${config.contextPolicy}` : 'off'}`);
  io.write(`Conversation    : ${config.conversationMode}`);
  io.write(`Local action    : ${config.execMode === 'script' ? 'EXEC SCRIPT [EXPERIMENTAL]' : config.writeMode === 'auto' ? 'AUTO-WRITE' : 'OFF'}`);
  io.write(`write-mode      : ${config.writeMode}`);
  io.write(`exec-mode       : ${config.execMode}`);
  io.write(`Tool format     : ${config.toolMode}`);
  if (isUploadMode(mode)) io.write(`Upload          : max ${config.uploadMaxFiles} selected; max 3 attachments per message`);
  io.write(`Status/diag     : m365proxy status --port ${config.port}`);
  io.write(`Local API key   : m365proxy key --state-dir ${shellQuote(config.stateDir)}`);
  io.write(SUBRULE);
  if (config.execMode === 'script') io.write('WARNING: this profile will execute model-generated code under your user privileges.');
  if (config.writeMode === 'auto') io.write('AUTO-WRITE: this profile can modify workspace files without per-change confirmation.');
  io.write('Equivalent command (displayed for reference, not run in shell):');
  io.write('  m365proxy ' + args.map(shellQuote).join(' '));

  section(io, 8, 8, 'Save & Start', [
    'Saving stores this configuration as an independent profile. Passwords, cookies, tokens, and API keys are NEVER saved in the profile JSON.',
  ]);
  if (name && await yes(io, `Save as profile '${name}'`, true)) {
    await persist(base.stateDir, name, args, { overwrite });
    io.write(`Profile saved: ${name}`);
    io.write(`To start later: m365proxy profile run ${shellQuote(name)}`);
  }
  if (!await yes(io, 'Start now in this terminal', true)) return null;
  banner(io, 'STARTUP', name ? `Profile: ${name}` : 'temporary profile');
  io.write('1. Complete sign-in / MFA in the dedicated browser tab if prompted.');
  io.write('2. If token is missing, send a short message in Copilot to open Chathub.');
  io.write('3. Wait for [AUTH] SESSION CAPTURED before sending client requests.');
  io.write('4. Keep this terminal open. Press Ctrl+C to stop the proxy and release the lock.');
  return { command: 'serve', config, profileName: name };
}

function inferredPreset(config) {
  if (!config.workspaceRoot) return 'chat';
  if (config.execMode === 'script') return 'full';
  if (config.contextMode === 'read' && config.writeMode === 'off') return 'readonly';
  return 'advanced';
}

async function saveAndMaybeStart({ base, io, name, args, persist, overwrite, label }) {
  const config = readConfig(args, {});
  banner(io, 'PROFILE SUMMARY', name ? `Name: ${name}` : 'Unsaved');
  io.write(`Recommended mode : ${label}`);
  io.write(`Local API        : http://127.0.0.1:${config.port}/v1`);
  io.write(`Workspace        : ${valueLabel(config.workspaceRoot, 'none')}`);
  io.write(`Conversation     : ${config.conversationMode}`);
  io.write(`Context          : ${config.workspaceRoot ? `${config.contextMode}/${config.contextPolicy}` : 'off'}`);
  io.write(`Local access     : ${config.execMode === 'script' ? 'FULL: local scripts via direct Chathub' : 'no execution'}`);
  io.write(`Browser upload   : ${isUploadMode(config.contextMode) ? 'active (advanced/experimental)' : 'off'}`);
  io.write(`Tool format      : ${config.toolMode}`);
  io.write(SUBRULE);
  if (config.execMode === 'script') {
    io.write('FULL WORKSPACE: the model can execute scripts with proxy user privileges.');
    io.write('The workspace is NOT uploaded automatically: it is inspected on-demand via the local bridge.');
  }
  io.write('Equivalent command:');
  io.write('  m365proxy ' + args.map(shellQuote).join(' '));
  io.write('');
  if (name && await yes(io, `Save as profile '${name}'`, true)) {
    await persist(base.stateDir, name, args, { overwrite });
    io.write(`Profile saved: ${name}`);
  }
  if (!await yes(io, 'Start now in this terminal', true)) return null;
  banner(io, 'STARTUP', name ? `Profile: ${name}` : 'temporary profile');
  io.write('1. Complete sign-in / MFA if prompted.');
  io.write('2. Wait for [AUTH] SESSION CAPTURED.');
  io.write('3. Use the Base URL from the summary in PrAImate/OpenClaude/OpenCode.');
  io.write('4. Ctrl+C stops the proxy and releases the lock.');
  return { command: 'serve', config, profileName: name };
}

export async function configureGuided(base, io, {
  persist = saveNamedProfile, profileName, overwrite = false, cwd = process.cwd(), askProfileName = true,
} = {}) {
  let name = profileName;
  if (!name && askProfileName) name = validateProfileName(await answer(io, 'Name for this profile', suggestedProfile(base, cwd)));
  if (name) {
    const exists = await loadNamedProfile(base.stateDir, name).catch(() => null);
    if (exists && !overwrite) throw new ProxyError(409, 'profile_exists', `Profile '${name}' already exists. Edit it from the menu or use a different name; not overwritten.`);
  }

  banner(io, 'M365PROXY 0.9.0 - CONFIGURATION', `Profile: ${name ?? '(unsaved)'}`);
  io.write('Choose a stable mode first. Only "Advanced" exposes all detailed low-level switches.');
  io.write('');
  io.write('  1 FULL WORKSPACE [RECOMMENDED]');
  io.write('      Workspace access + local script execution bridge.');
  io.write('      Uses direct Chathub and DOES NOT rely on composer/uploader for local actions.');
  io.write('');
  io.write('  2 WORKSPACE READ-ONLY [STABLE]');
  io.write('      Reads selected context and sends via direct Chathub. No execution or file writes.');
  io.write('');
  io.write('  3 CHAT ONLY');
  io.write('      OpenAI-compatible proxy without local workspace access.');
  io.write('');
  io.write('  4 ADVANCED / LEGACY');
  io.write('      Upload/hybrid, auto-write, and detailed settings. Useful for testing, not default.');
  io.write(SUBRULE);
  const inferred = (!profileName && !base.workspaceRoot) ? 1 : (({ full: 1, readonly: 2, chat: 3, advanced: 4 })[inferredPreset(base)] ?? 1);
  const preset = await integer(io, 'Profile mode', inferred, 1, 4);
  if (preset === 4) return configureAdvancedGuided(base, io, { persist, profileName: name, overwrite, cwd, askProfileName: false });

  section(io, 1, 3, 'Local Connection', ['Playwright Chromium is the recommended browser for maintaining the Microsoft session.']);
  const port = await integer(io, 'Local port', base.port, 1, 65535);
  io.write('  1 Playwright Chromium (recommended)');
  io.write('  2 Installed Microsoft Edge');
  io.write('  3 Installed Google Chrome');
  const channelIndex = ['chromium', 'msedge', 'chrome'].indexOf(base.channel) + 1;
  const channel = ['chromium', 'msedge', 'chrome'][(await integer(io, 'Browser', channelIndex || 1, 1, 3)) - 1];
  const headless = await yes(io, 'Headless browser', false);
  const args = ['--port', String(port), '--state-dir', base.stateDir, '--channel', channel];
  if (headless) args.push('--headless');

  if (preset === 3) {
    section(io, 2, 3, 'Chat', ['No workspace, no file writing, and no script execution.']);
    args.push('--conversation-mode', 'reuse', '--write-mode', 'off', '--exec-mode', 'off', '--tool-mode', 'guarded');
    section(io, 3, 3, 'Save & Start', ['Minimal and stable configuration.']);
    return saveAndMaybeStart({ base, io, name, args, persist, overwrite, label: 'CHAT ONLY' });
  }

  section(io, 2, 3, 'Workspace', [preset === 1
    ? 'FULL uses the local bridge to inspect/modify the host. Does not upload the repository automatically.'
    : 'READ-ONLY selects relevant files and sends them via direct transport.']);
  const folder = expanded(await answer(io, 'Workspace directory', base.workspaceRoot ?? cwd));
  args.push('--workspace', folder, '--context-mode', 'read', '--context-policy', 'adaptive', '--conversation-mode', 'reuse');
  if (preset === 1) {
    args.push('--write-mode', 'off', '--exec-mode', 'script', '--exec-max-steps', '6', '--exec-timeout-ms', '30000', '--tool-mode', 'guarded', '--timeout-ms', '300000');
    io.write('');
    io.write('FULL WORKSPACE is configured with a deterministic execution path:');
    io.write('  client -> proxy -> direct Chathub -> local script -> result -> same Chathub');
    io.write('Never switches to browser-upload based on prompt keywords.');
  } else {
    args.push('--write-mode', 'off', '--exec-mode', 'off', '--tool-mode', 'guarded', '--timeout-ms', '90000');
  }
  section(io, 3, 3, 'Save & Start', ['You can edit this later or switch to Advanced without losing the profile.']);
  return saveAndMaybeStart({ base, io, name, args, persist, overwrite, label: preset === 1 ? 'FULL WORKSPACE [RECOMMENDED]' : 'WORKSPACE READ-ONLY [STABLE]' });
}

export async function runGuidedMenu(base, {
  direct = false, io = terminalIO(), diagnoseFn = diagnose, changeFn = changeCommand,
  persist = saveNamedProfile, cwd,
} = {}) {
  try {
    await importLegacyProfile(base.stateDir).catch(() => false);
    if (direct) return await configureGuided(base, io, { persist, cwd });
    let current = base;
    for (;;) {
      banner(io, 'M365PROXY 0.9.0', 'Main Menu');
      io.write(`State directory: ${base.stateDir}`);
      io.write('Create/Edit starts with three simple modes; legacy options are inside Advanced.');
      menuGroup(io, 'PROFILES', [
        '  1 Create new configuration step-by-step',
        '  2 Start a saved configuration',
        '  3 List saved profiles',
        '  4 Edit a configuration',
        ' 12 Delete a profile',
      ]);
      menuGroup(io, 'STATUS AND DIAGNOSTICS', [
        '  5 Check proxy status',
        '  6 Run a test probe request',
        '  7 Show connection info / local API key',
        '  8 Preview workspace context files',
        '  9 Open Microsoft sign-in (browser only)',
      ]);
      menuGroup(io, 'LOCAL CHANGES', [
        ' 10 View saved change history / backups',
        ' 11 Undo a change by change ID',
      ]);
      io.write('');
      io.write('  0 Exit');
      io.write(SUBRULE);
      const choice = await integer(io, 'Choice', 1, 0, 12);
      if (choice === 0) return null;
      if (choice === 1) return await configureGuided(current, io, { persist, cwd });
      if (choice === 2) {
        const picked = await chooseProfile(io, base.stateDir, 'Profile to start'); if (!picked) continue;
        current = picked.config; showConnection(current, io);
        if (current.workspaceRoot) io.write(`Folder: ${current.workspaceRoot}; mode ${current.contextMode}; context ${current.contextPolicy}; exec ${current.execMode}; chat ${current.conversationMode}.`);
        if (await yes(io, `Start '${picked.name}'`, true)) return { command: 'serve', config: current, profileName: picked.name };
      } else if (choice === 3) {
        const profiles = await namedProfiles(base.stateDir);
        if (!profiles.length) io.write('No saved profiles found.');
        else {
          io.write(''); io.write('SAVED PROFILES'); io.write(SUBRULE);
          for (const p of profiles) {
            if (!p.valid) { io.write(`[ERROR] ${p.name} | ${p.error}`); continue; }
            const action = p.exec_mode === 'script' ? 'EXEC[EXP]' : p.write_mode === 'auto' ? 'AUTO-WRITE' : 'OFF';
            io.write(`[OK] ${p.name}`);
            io.write(`     API  : 127.0.0.1:${p.port} | chat ${p.conversation_mode} | actions ${action}`);
            io.write(`     WS   : ${p.workspace ? `${p.mode}/${p.context_policy ?? 'adaptive'} | ${p.workspace}` : 'no workspace'}`);
          }
          io.write(SUBRULE);
        }
      } else if (choice === 4) {
        const picked = await chooseProfile(io, base.stateDir, 'Profile to edit'); if (!picked) continue;
        return await configureGuided(picked.config, io, { persist, profileName: picked.name, overwrite: true, cwd });
      } else if (choice === 5 || choice === 6) {
        const picked = await chooseProfile(io, base.stateDir, 'Use configuration from');
        current = picked?.config ?? current;
        const port = await integer(io, 'Port of running proxy', current.port, 1, 65535);
        if (choice === 6 && !await yes(io, 'The test sends a query and workspace context configured on THAT server. Continue', false)) continue;
        await diagnoseFn(choice === 5 ? 'status' : 'probe', { ...current, port });
      } else if (choice === 7) {
        const picked = await chooseProfile(io, base.stateDir, 'Show connection for');
        current = picked?.config ?? current; showConnection(current, io);
        if (await yes(io, 'Show local API key in this terminal (do not share)', false)) io.write(await getApiKey(current.stateDir));
      } else if (choice === 8) {
        const picked = await chooseProfile(io, base.stateDir, 'Preview profile'); if (picked) { current = picked.config; await preview(current, io); }
      } else if (choice === 9) {
        const picked = await chooseProfile(io, base.stateDir, 'Use browser configuration from');
        current = picked?.config ?? current; return { command: 'login', config: { ...current, headless: false }, profileName: picked?.name };
      } else if (choice === 10 || choice === 11) {
        const picked = await chooseProfile(io, base.stateDir, 'Use configuration from'); current = picked?.config ?? current;
        const port = await integer(io, 'Port of running proxy', current.port, 1, 65535);
        if (choice === 10) await changeFn('changes', { ...current, port }, { output: io.write });
        else {
          const changeId = await answer(io, 'Change ID to undo (see option 10)');
          await changeFn('undo', { ...current, port, changeId }, { output: io.write });
        }
      } else if (choice === 12) {
        const picked = await chooseProfile(io, base.stateDir, 'Profile to delete'); if (!picked) continue;
        if (await yes(io, `Delete profile '${picked.name}' (does not delete workspace, login, or backups)`, false)) {
          await deleteNamedProfile(base.stateDir, picked.name); io.write(`Profile '${picked.name}' deleted.`);
        }
      }
    }
  } finally { io.close(); }
}
