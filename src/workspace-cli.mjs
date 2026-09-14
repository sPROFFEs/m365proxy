import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { getApiKey } from './util.mjs';
import { WorkspaceManager } from './workspace.mjs';
import { ProxyError, invalid, publicError } from './errors.mjs';

export async function boundedFile(path, limit) {
  if (!path) throw invalid('Provide --prompt-file or --proposal as required by the command.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw invalid('Input must be a regular file within the command size limit.');
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break; size += bytesRead;
    }
    if (size > limit) throw invalid('Input exceeds the command size limit.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)); }
    catch { throw invalid('Input must be UTF-8 text.'); }
  } finally { await handle.close(); }
}
export async function workspaceCommand(command, config, { output = console.log } = {}) {
  try {
    if (command === 'context' && (config.workspaceRoot || config.workspacesFile)) {
      const manager = await WorkspaceManager.fromConfig(config);
      const snapshot = await manager.snapshot(config.projectId, config.contextQuery);
      output(JSON.stringify({ ...snapshot.summary, sent_to_microsoft: false }, null, 2)); return 0;
    }
    const base = `http://${config.host}:${config.port}`;
    const key = await getApiKey(config.stateDir);
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      ...(config.projectId ? { 'X-M365-Project': config.projectId } : {}) };
    const call = async (path, body, timeoutMs = 15000) => {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
      const data = await response.json();
      if (!response.ok) throw new ProxyError(response.status, data.error?.code ?? 'local_request_error', data.error?.message ?? 'Local workspace request failed.');
      return data;
    };
    if (command === 'context') {
      const data = await call('/local/context', { project: config.projectId, query: config.contextQuery });
      output(JSON.stringify(data, null, 2)); return 0;
    }
    if (command === 'patch-check') {
      let bundle;
      try { bundle = JSON.parse(await boundedFile(config.proposalFile, 1048576)); }
      catch (e) { if (e.name === 'ProxyError') throw e; throw invalid('Cannot read the proposal JSON bundle.'); }
      output(JSON.stringify(await call('/local/patch/check', bundle), null, 2)); return 0;
    }
    if (command !== 'propose') throw invalid('Unknown workspace command.');
    if (config.workspaceRoot || config.workspacesFile) throw invalid('propose uses the running server registry. Configure its workspace at startup, then use --project ID.');
    const registry = await call('/local/workspaces');
    const id = config.projectId ?? registry.default_project;
    const project = registry.projects?.find((p) => p.id === id);
    if (project?.mode !== 'patch') throw invalid('propose requires a configured patch-mode project. Use --project ID or start with --workspace PATH --context-mode patch.');
    headers['X-M365-Project'] = id;
    const prompt = await boundedFile(config.promptFile, 65536);
    if (!prompt.trim()) throw invalid('The prompt file is empty.');
    const response = await call('/v1/chat/completions', { model: config.defaultModel,
      messages: [{ role: 'user', content: prompt }], tools: [], tool_choice: 'none', stream: false }, config.requestTimeoutMs + 10000);
    const workspace = response.x_m365?.workspace;
    if (!workspace) throw new ProxyError(502, 'workspace_metadata_missing', 'The server response did not include workspace metadata.');
    if (config.outputFile && workspace.proposal) {
      // Explicit export only, no overwrite and no application. The server itself
      // never persists source text or proposal patches.
      const handle = await open(config.outputFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(workspace.proposal, null, 2) + '\n'); }
      finally { await handle.close(); }
      output(JSON.stringify({ proposal_id: workspace.proposal.id, exported: config.outputFile, applied: false,
        project_id: workspace.project_id, snapshot_id: workspace.snapshot_id,
        next_step: 'Review the JSON patch and run m365proxy patch-check --proposal FILE before any manual action.' }, null, 2));
    } else {
      output(JSON.stringify({ answer: response.choices?.[0]?.message?.content, workspace, applied: false }, null, 2));
    }
    return 0;
  } catch (error) {
    const e = error?.code === 'EEXIST' ? new ProxyError(409, 'output_exists', 'The output file already exists; choose a new name. It was not overwritten.') : publicError(error);
    output(JSON.stringify({ error: e.toJSON().error, applied: false, automatic_retries: false }, null, 2)); return 2;
  }
}
