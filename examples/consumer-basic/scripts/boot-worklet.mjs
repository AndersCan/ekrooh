#!/usr/bin/env node
/**
 * Bundles and runs the consumer worklet for dev (`--watch`) and the real-stack
 * e2e. Mirrors the framework's `scripts/dev-bare.mjs`: esbuild-bundle the
 * worklet entry with packages externalized, then spawn the `bare` runtime on
 * it.
 *
 * Usage:
 *   node scripts/boot-worklet.mjs [--watch] [--bundle-only] [--web-assets <dir>]
 *
 * `--web-assets <dir>` points the worklet at a built web app, which its
 * loopback server serves at `/` — the on-device same-origin topology
 * (docs hosts/testing.mdx). `CONSUMER_BASIC_PORT` overrides the dev/e2e port
 * (default 8080).
 */
import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'worklet', 'entry.ts');
const outfile = path.join(root, 'worklet', 'app.core.gen.js');
const require = createRequire(import.meta.url);
const bareExecutable = require('bare-runtime')();

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const bundleOnly = args.includes('--bundle-only');
const webAssetsIndex = args.indexOf('--web-assets');
const webAssets =
  webAssetsIndex >= 0
    ? path.resolve(root, args[webAssetsIndex + 1])
    : undefined;
const port = process.env.CONSUMER_BASIC_PORT ?? '8080';

const appArgs = [];
if (webAssets) appArgs.push('--web-assets', webAssets);
appArgs.push('--port', port);

const buildOptions = {
  entryPoints: [entry],
  outfile,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  logLevel: 'info',
};

let bareProcess = null;
let restartTimer = null;
let shuttingDown = false;
let restartChain = Promise.resolve();
let lastRestartAt = 0;

function log(message) {
  console.log(`[consumer-basic] ${message}`);
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

  bareProcess = spawn(bareExecutable, [outfile, ...appArgs], {
    stdio: 'inherit',
  });
  log(`Started Bare process (pid=${bareProcess.pid ?? 'unknown'}).`);

  bareProcess.on('exit', (code, signal) => {
    if (bareProcess && code !== 0 && !shuttingDown) {
      log(
        `Bare exited unexpectedly (code=${code}, signal=${signal ?? 'none'})`,
      );
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
  if (bundleOnly) {
    await build(buildOptions);
    log(`Bundled ${path.relative(root, outfile)}.`);
    return;
  }

  if (watch) {
    const watchContext = await context({
      ...buildOptions,
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
    await watchContext.watch();
    log(
      'Watching worklet/entry.ts and restarting Bare after successful rebuilds.',
    );

    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('Shutting down...');
      if (restartTimer) clearTimeout(restartTimer);
      await stopBare();
      await watchContext.dispose();
      process.exit(0);
    };

    process.on('SIGINT', () => {
      void shutdown();
    });
    process.on('SIGTERM', () => {
      void shutdown();
    });
    return;
  }

  await build(buildOptions);
  await startBare();
}

void main().catch(async (error) => {
  console.error('[consumer-basic] Fatal error:', error);
  await stopBare();
  process.exit(1);
});
