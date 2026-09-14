// Offline fixture: REAL service, kernel lock and OS signals, fake browser/core.
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runService } from '../../src/service.mjs';
import { config, fakeCore } from '../helpers.mjs';
const stateDir = process.argv[2]; const mode = process.argv[3] ?? 'normal';
class Browser extends EventEmitter {
  status() { return { state: 'authentication_required' }; }
  async start() { console.log('FIXTURE_STARTED'); if (mode === 'starting') await new Promise(() => {}); }
  enableMaintenance() {}
  async close() {
    await writeFile(join(stateDir, 'browser-close-was-called'), 'yes');
    if (mode === 'hanging-close') await new Promise(() => {});
    if (mode === 'throwing-close') throw new Error('Synthetic browser-close error');
  }
}
const code = await runService({ ...config, stateDir, firstTokenTimeoutMs: 100, idleTimeoutMs: 100 }, {
  coreLoader: async () => fakeCore(), chromiumLoader: async () => ({}), authFactory: () => new Browser(), cleanupTimeoutMs: 80,
});
process.exit(code ?? 0);
