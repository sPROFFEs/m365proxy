// Exact aliases only. Do not turn every arbitrary POST into inference. Never log
// query strings or unknown path segments: they may contain tokens/account IDs.
const groups = {
  health: ['/health'],
  workspaces: ['/local/workspaces'],
  workspace_context: ['/local/context'],
  patch_check: ['/local/patch/check'],
  changes: ['/local/changes'],
  changes_undo: ['/local/changes/undo'],
  models: ['/v1/models', '/models'],
  chat_completions: ['/v1/chat/completions', '/chat/completions'],
  responses: ['/v1/responses', '/responses'],
  ollama_chat: ['/api/chat'],
  ollama_tags: ['/api/tags'],
  ollama_show: ['/api/show'],
  ollama_version: ['/api/version'],
};
const aliases = {
  models: ['/api/models', '/api/v1/models', '/v1/v1/models'],
  chat_completions: ['/api/chat/completions', '/api/v1/chat/completions', '/v1/v1/chat/completions'],
  responses: ['/api/responses', '/api/v1/responses', '/v1/v1/responses'],
  ollama_chat: ['/v1/api/chat'],
  ollama_tags: ['/v1/api/tags'],
  ollama_show: ['/v1/api/show'],
  ollama_version: ['/v1/api/version'],
};
export function resolveRoute(path, method, compatMode = true) {
  for (const [name, paths] of Object.entries(groups)) {
    const alias = compatMode && aliases[name]?.includes(path);
    if (!paths.includes(path) && !alias) continue;
    const expected = ['chat_completions', 'responses', 'ollama_chat', 'ollama_show', 'workspace_context', 'patch_check', 'changes_undo'].includes(name) ? 'POST' : 'GET';
    return { name: method === expected ? name : 'wrong_method', expected, alias: Boolean(alias), ollama: name.startsWith('ollama_') };
  }
  return { name: 'unknown', alias: false, ollama: false };
}
const harmlessSegments = new Set(['v1', 'api', 'chat', 'completions', 'responses', 'models', 'messages', 'generate', 'show', 'tags', 'version', 'health', 'embeddings', 'local', 'workspaces', 'context', 'patch', 'check', 'changes', 'undo']);
export function diagnosticPath(path) {
  return path.length < 100 && path.split('/').filter(Boolean).every((segment) => harmlessSegments.has(segment)) ? path : '<unrecognized-path>';
}
