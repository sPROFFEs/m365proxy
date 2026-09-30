// Installed as PREFIX/bin/m365proxy-launcher.mjs and invoked by m365proxy.cmd.
// The .cmd shim only locates the private Node runtime; argument routing stays in
// Node so PowerShell/cmd quoting does not reinterpret CLI options such as --port.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const binDir = dirname(fileURLToPath(import.meta.url));
const prefix = dirname(binDir);

async function text(path, label) {
  let value;
  try { value = (await readFile(path, 'utf8')).trim(); }
  catch { throw new Error(`Installation incomplete: ${label} is missing. Reinstall m365proxy.`); }
  if (!value) throw new Error(`Installation incomplete: ${label} is empty. Reinstall m365proxy.`);
  return value;
}

function run(script, args) {
  const child = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env });
  if (child.error) throw child.error;
  if (child.signal) return 1;
  return child.status ?? 1;
}

try {
  const app = await text(join(prefix, 'current.txt'), 'current.txt');
  const configuredNode = await text(join(app, '.node-path'), '.node-path');
  if (configuredNode.toLowerCase() !== process.execPath.toLowerCase()) {
    throw new Error('The launcher is running with a different Node runtime than the active release. Re-run install.ps1.');
  }

  process.env.PLAYWRIGHT_BROWSERS_PATH = join(prefix, 'browsers');
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
  process.env.PATH = `${dirname(process.execPath)};${process.env.PATH ?? ''}`;

  const input = process.argv.slice(2);
  let command = input[0] ?? 'serve';
  let forward;

  if (command === '-h' || command === '--help' || command === 'help') {
    process.exitCode = run(join(app, 'src', 'cli.mjs'), ['help']);
  } else if (command === '--version' || command === 'version') {
    const pkg = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
    console.log(`m365proxy ${pkg.version}`);
  } else {
    if (command.startsWith('--')) {
      forward = input;
      command = 'serve';
    } else {
      forward = input.slice(1);
    }
    if (command === 'start') command = 'serve';

    const cliCommands = new Set(['serve', 'login', 'menu', 'guided', 'profile', 'profiles', 'key', 'doctor', 'status', 'probe', 'unlock', 'context', 'propose', 'patch-check', 'ask', 'changes', 'undo']);
    if (cliCommands.has(command)) {
      process.exitCode = run(join(app, 'src', 'cli.mjs'), [command, ...forward]);
    } else if (command === 'check-browser') {
      process.exitCode = run(join(app, 'scripts', 'browser-setup.mjs'), ['check', ...forward]);
    } else if (command === 'repair') {
      process.exitCode = run(join(app, 'scripts', 'bootstrap.mjs'), forward);
    } else if (command === 'demo-tools') {
      process.exitCode = run(join(app, 'examples', 'tool-loop.mjs'), forward);
    } else {
      console.error(`Unknown command: ${command}. Run m365proxy help.`);
      process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
