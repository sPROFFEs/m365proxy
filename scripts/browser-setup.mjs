// Uses the exact Playwright dependency installed under cramt, never @latest.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { run } from './process.mjs';
import { loadChromium } from '../src/core-loader.mjs';
const command = process.argv[2];
try {
  if (command === 'install') {
    const require = createRequire(new URL('../vendor/cramt/packages/core/package.json', import.meta.url));
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
    await run(process.execPath, [cli, 'install', 'chromium']);
  } else if (command === 'check') {
    const chromium = await loadChromium();
    let browser;
    try {
      browser = await chromium.launch({ headless: true, timeout: 30000 });
      const page = await browser.newPage();
      await page.goto('about:blank');
      console.log('Chromium smoke test passed (about:blank; no Microsoft request).');
    } finally { await browser?.close(); }
  } else throw new Error('Usage: node scripts/browser-setup.mjs install|check');
} catch (error) {
  // Browser check uses no account profile, so missing-library diagnostics are safe.
  console.error(`Browser setup failed: ${error.message}`);
  console.error('Check OS libraries, download access and Playwright support for your distribution.');
  process.exitCode = 1;
}
