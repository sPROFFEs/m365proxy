import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ProxyError } from './errors.mjs';
export const upstreamRoot = fileURLToPath(new URL('../vendor/cramt/', import.meta.url));
export const coreUrl = new URL('../vendor/cramt/packages/core/dist/index.mjs', import.meta.url);
export async function loadCore() {
  // Disable credential/prompt/frame dumps inherited from an unrelated shell.
  for (const key of ['M365_DEBUG', 'M365_TRACE', 'M365_LOG_STDOUT', 'M365_DUMP_FRAMES', 'M365_INJECT_REPLY_TOOL']) delete process.env[key];
  process.env.M365_NO_IMAGE_GEN = '1';
  process.env.M365_NO_INTERACTIVE = '1';
  delete process.env.M365_ENABLE_INTERACTIVE_APPROVAL;
  try { await access(coreUrl); } catch {
    throw new ProxyError(503, 'upstream_not_installed', 'The pinned cramt sources and build are missing. Run npm run setup. This distribution does not contain a fabricated replacement.');
  }
  let core;
  try { core = await import(coreUrl.href); } catch {
    throw new ProxyError(503, 'upstream_load_failed', 'Cannot load cramt. Run npm run setup with Node 24+ and review npm run verify:upstream.');
  }
  for (const name of ['ModelSession', 'formatMessages', 'parseToolCalls', 'getAvailableModels']) if (typeof core[name] !== 'function') throw new ProxyError(503, 'upstream_contract_changed', `The pinned build lacks the expected ${name} export.`);
  return core;
}
export async function loadChromium() {
  const require = createRequire(new URL('../vendor/cramt/packages/core/package.json', import.meta.url));
  try { return require('playwright').chromium; } catch {
    throw new ProxyError(503, 'playwright_missing', 'Playwright is missing. Run npm run setup.');
  }
}
