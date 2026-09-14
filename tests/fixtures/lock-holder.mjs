import { acquireLock } from '../../src/util.mjs';
try {
  const release = await acquireLock(process.argv[2]);
  console.log('READY');
  await new Promise((resolve) => { process.stdin.on('end', resolve); process.stdin.resume(); });
  await release();
} catch (error) { console.error(error.code); process.exitCode = 1; }
