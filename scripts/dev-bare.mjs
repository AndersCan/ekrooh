import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const outFile = 'core/main.core.gen.js';
const require = createRequire(import.meta.url);
const bareExecutable = require('bare-runtime')();

let bareProcess = null;
let restartTimer = null;
let shuttingDown = false;
let restartChain = Promise.resolve();
let lastRestartAt = 0;

function log(message) {
  console.log(`[dev:bare] ${message}`);
}

function stopBare() {
  return new Promise((resolve) => {
    if (!bareProcess) return resolve();
    const processToStop = bareProcess;
    bareProcess = null;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    processToStop.once('exit', () => finish());
    processToStop.kill('SIGTERM');

    setTimeout(() => {
      if (finished) return;
      processToStop.kill('SIGKILL');
      setTimeout(() => finish(), 500);
    }, 1200);
  });
}

async function startBare() {
  await stopBare();
  if (shuttingDown) return;

  bareProcess = spawn(bareExecutable, [outFile], {
    stdio: 'inherit',
  });
  log(`Started Bare process (pid=${bareProcess.pid ?? 'unknown'}).`);

  bareProcess.on('exit', (code, signal) => {
    if (bareProcess && code !== 0 && !shuttingDown) {
      log(`Bare exited unexpectedly (code=${code}, signal=${signal ?? 'none'})`);
    }
  });
}

function scheduleRestart() {
  const now = Date.now();
  if (now - lastRestartAt < 1000) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    lastRestartAt = Date.now();
    restartChain = restartChain.then(() => startBare());
  }, 50);
}

async function main() {
  const buildContext = await context({
    entryPoints: ['core/main.core.ts'],
    outfile: outFile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'info',
    plugins: [
      {
        name: 'restart-bare-on-build',
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length === 0) {
              scheduleRestart();
            } else {
              log('Build failed; skipping Bare restart.');
            }
          });
        },
      },
    ],
  });

  await buildContext.watch();
  log('Watching core/main.core.ts and restarting Bare after successful rebuilds.');

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down...');
    if (restartTimer) clearTimeout(restartTimer);
    await stopBare();
    await buildContext.dispose();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

void main().catch(async (error) => {
  console.error('[dev:bare] Fatal error:', error);
  await stopBare();
  process.exit(1);
});
