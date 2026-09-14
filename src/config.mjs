import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { invalid } from './errors.mjs';

function envBool(value, fallback) {
  if (value === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  throw invalid(`Invalid boolean value: ${value}`);
}

export function readConfig(argv = [], env = process.env) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--headless', '--strict', '--compat'].includes(key)) { values[key] = true; continue; }
    if (!['--port', '--state-dir', '--channel', '--model', '--tool-mode', '--repair-attempts', '--timeout-ms', '--first-token-timeout-ms', '--idle-timeout-ms', '--workspace', '--workspace-id', '--workspaces', '--context-mode', '--context-max-bytes', '--context-max-files', '--context-max-file-bytes', '--context-scan-timeout-ms', '--project', '--query', '--prompt-file', '--output', '--proposal', '--upload-max-files', '--upload-max-file-size', '--upload-max-bytes', '--upload-timeout-ms', '--upload-ui-config', '--write-mode', '--queue-size', '--queue-timeout-ms', '--change-id', '--conversation-mode', '--conversation-ttl-ms', '--conversation-max', '--conversation-max-turns', '--context-policy', '--exec-mode', '--exec-max-steps', '--exec-timeout-ms', '--exec-output-bytes'].includes(key)) throw invalid(`Unknown option: ${key}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw invalid(`Missing value for ${key}`);
    values[key] = value;
  }
  if (values['--strict'] && values['--compat']) throw invalid('Choose either --strict or --compat, not both.');
  const number = (value, fallback, min, max) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw invalid(`Number must be an integer from ${min} to ${max}.`);
    return n;
  };
  const channel = values['--channel'] ?? env.M365_LOCAL_CHANNEL ?? 'chromium';
  const toolMode = values['--tool-mode'] ?? env.M365_LOCAL_TOOL_MODE ?? 'guarded';
  if (!['chromium', 'msedge', 'chrome'].includes(channel)) throw invalid('channel must be chromium, msedge or chrome.');
  if (!['guarded', 'cramt'].includes(toolMode)) throw invalid('tool-mode must be guarded or cramt.');

  let compatMode = envBool(env.M365PROXY_COMPAT_MODE ?? env.M365_LOCAL_COMPAT_MODE, true);
  const strictEnv = envBool(env.M365PROXY_STRICT ?? env.M365_LOCAL_STRICT, false);
  if (strictEnv) compatMode = false;
  if (values['--strict']) compatMode = false;
  if (values['--compat']) compatMode = true;

  const chosenMode = values['--context-mode'] ?? env.M365PROXY_CONTEXT_MODE ?? 'read';
  const contextMode = chosenMode === 'prompt' ? 'read' : chosenMode;
  if (!['read', 'patch', 'upload', 'hybrid'].includes(contextMode)) throw invalid('context-mode must be read, prompt, patch, upload or hybrid.');
  const uploads = ['upload', 'hybrid'].includes(contextMode);
  const contextPolicy = values['--context-policy'] ?? env.M365PROXY_CONTEXT_POLICY ?? 'adaptive';
  if (!['adaptive', 'always'].includes(contextPolicy)) throw invalid('context-policy must be adaptive or always.');
  const workspace = values['--workspace'] ?? env.M365PROXY_WORKSPACE;
  const registry = values['--workspaces'] ?? env.M365PROXY_WORKSPACES;
  if (workspace && registry) throw invalid('Choose --workspace or --workspaces, not both.');

  const writeMode = values['--write-mode'] ?? env.M365PROXY_WRITE_MODE ?? 'off';
  const execMode = values['--exec-mode'] ?? env.M365PROXY_EXEC_MODE ?? 'off';
  if (!['off', 'auto'].includes(writeMode)) throw invalid('write-mode must be off or auto.');
  if (!['off', 'script'].includes(execMode)) throw invalid('exec-mode must be off or script.');
  const conversationMode = values['--conversation-mode'] ?? env.M365PROXY_CONVERSATION_MODE ?? 'reuse';
  if (!['reuse', 'fresh'].includes(conversationMode)) throw invalid('conversation-mode must be reuse or fresh.');
  if (writeMode === 'auto' && !workspace && !registry) throw invalid('Automatic writes require an explicitly registered workspace.');
  if (execMode === 'script' && !workspace && !registry) throw invalid('Experimental script execution requires an explicitly registered workspace.');
  if (writeMode === 'auto' && contextMode === 'patch') throw invalid('Use read/upload/hybrid with write-mode auto; patch remains proposal-only.');
  if (execMode === 'script' && contextMode === 'patch') throw invalid('Experimental script execution cannot be combined with proposal-only patch mode.');
  if (execMode === 'script' && writeMode === 'auto') throw invalid('Choose automatic source writes OR experimental script execution, not both. Script mode can modify files itself.');

  return {
    writeMode,
    execMode,
    contextPolicy,
    execMaxSteps: number(values['--exec-max-steps'], 4, 1, 8),
    execTimeoutMs: number(values['--exec-timeout-ms'], 30000, 1000, 120000),
    execOutputBytes: number(values['--exec-output-bytes'], 65536, 1024, 262144),
    conversationMode,
    maxSessions: number(values['--conversation-max'], 8, 1, 32),
    sessionTtlMs: number(values['--conversation-ttl-ms'], 3600000, 60000, 86400000),
    sessionMaxTurns: number(values['--conversation-max-turns'], 32, 1, 256),
    queueMaxPending: number(values['--queue-size'], 4, 0, 32),
    queueWaitMs: number(values['--queue-timeout-ms'], 240000, 1000, 900000),
    changeId: values['--change-id'],
    workspaceRoot: workspace ? resolve(workspace) : undefined,
    workspaceId: values['--workspace-id'] ?? 'default',
    workspacesFile: registry ? resolve(registry) : undefined,
    contextMode,
    uploadMaxFiles: number(values['--upload-max-files'], 5, 1, 20),
    uploadMaxFileBytes: number(values['--upload-max-file-size'], 1048576, 1024, 2097152),
    uploadMaxBytes: number(values['--upload-max-bytes'], 4194304, 4096, 8388608),
    uploadTimeoutMs: number(values['--upload-timeout-ms'], 90000, 1000, 300000),
    uploadUiFile: values['--upload-ui-config'] ? resolve(values['--upload-ui-config']) : undefined,
    contextMaxBytes: number(values['--context-max-bytes'], 65536, 4096, 262144),
    contextMaxFiles: number(values['--context-max-files'], 16, 1, 64),
    contextMaxFileBytes: number(values['--context-max-file-bytes'], 32768, 1024, 262144),
    contextScanTimeoutMs: number(values['--context-scan-timeout-ms'], 5000, 1000, 30000),
    projectId: values['--project'],
    contextQuery: values['--query'] ?? '',
    promptFile: values['--prompt-file'] ? resolve(values['--prompt-file']) : undefined,
    outputFile: values['--output'] ? resolve(values['--output']) : undefined,
    proposalFile: values['--proposal'] ? resolve(values['--proposal']) : undefined,
    host: '127.0.0.1',
    port: number(values['--port'] ?? env.M365_LOCAL_PORT, 8787, 1, 65535),
    stateDir: resolve(values['--state-dir'] ?? env.M365_LOCAL_STATE_DIR ?? join(homedir(), '.m365-copilot-local')),
    channel,
    headless: Boolean(values['--headless']),
    defaultModel: values['--model'] ?? env.M365_LOCAL_MODEL ?? 'm365-copilot',
    toolMode,
    compatMode,
    repairAttempts: number(values['--repair-attempts'], 0, 0, 1),
    requestTimeoutMs: number(values['--timeout-ms'], execMode === 'script' ? 300000 : (uploads || registry) ? 240000 : 90000, 1000, 900000),
    firstTokenTimeoutMs: number(values['--first-token-timeout-ms'], 45000, 1000, 900000),
    idleTimeoutMs: number(values['--idle-timeout-ms'], 30000, 1000, 900000),
    captureTimeoutMs: 45000,
    loginTimeoutMs: 600000,
    maxBodyBytes: 1048576,
    maxOutputChars: 1048576,
    maxTools: 16,
  };
}
