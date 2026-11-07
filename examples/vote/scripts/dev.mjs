#!/usr/bin/env node
/**
 * `npm run dev`: bundles and runs the app backend (worklet) under Bare and
 * serves the page with Vite, in one process.
 */
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'worklet', 'app.core.gen.js');
const require = createRequire(import.meta.url);
const bareExecutable = require('bare-runtime')();
// npm ci can leave the prebuilt runtime without its execute bit.
if (process.platform !== 'win32') fs.chmodSync(bareExecutable, 0o755);

// `mode=dev` selects the dev backend (auth off). The origins let the Vite dev
// server (pinned to 5173 in vite.config.ts) open the protocol socket.
const appArgs = [
  'mode=dev',
  'origin=http://localhost:5173',
  'origin=http://127.0.0.1:5173',
  '--port',
  '8080',
];

let bareProcess = null;
let restartTimer = null;
let shuttingDown = false;
let restartChain = Promise.resolve();

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
    processToStop.once('exit', finish);
    processToStop.kill('SIGTERM');
    setTimeout(() => {
      if (finished) return;
      processToStop.kill('SIGKILL');
      setTimeout(finish, 500);
    }, 1200);
  });
}

async function startBare() {
  await stopBare();
  if (shuttingDown) return;
  bareProcess = spawn(bareExecutable, [outfile, ...appArgs], {
    stdio: 'inherit',
  });
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartChain = restartChain.then(() => startBare());
  }, 50);
}

const worklet = await context({
  entryPoints: [path.join(root, 'worklet', 'entry.ts')],
  outfile,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  logLevel: 'warning',
  plugins: [
    {
      name: 'restart-bare-on-build',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) scheduleRestart();
          else
            console.log(
              '[vote] Worklet build failed; keeping the old backend.',
            );
        });
      },
    },
  ],
});
await worklet.watch();

const server = await createServer({ root });
try {
  await server.listen();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('in use') || message.includes('EADDRINUSE')) {
    console.log(
      '[vote] Port 5173 is in use. Stop the other dev server and run npm run dev again.',
    );
  } else {
    console.log(`[vote] ${message}`);
  }
  shuttingDown = true;
  await stopBare();
  await worklet.dispose();
  process.exit(1);
}
server.printUrls();
console.log(
  'vote ready: http://localhost:5173 (browser only; the phone shows the last "npm run sync")',
);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  await stopBare();
  await worklet.dispose();
  await server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
