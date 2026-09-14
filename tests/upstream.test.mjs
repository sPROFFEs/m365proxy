import test from 'node:test';
import { existsSync } from 'node:fs';
import { coreUrl } from '../src/core-loader.mjs';

test('real cramt exported interface and token injection (no Microsoft network)', { skip: !existsSync(coreUrl) ? 'Pinned cramt could not be downloaded in the authoring environment. Run npm run setup and rerun npm test.' : false }, async () => {
  await import('../scripts/verify-upstream.mjs');
});
