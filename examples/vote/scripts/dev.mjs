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
// `npm run dev:second` starts a second copy beside the first, on other ports,
// so you can try sync with one computer: paste the first copy's code into it.
const second = process.argv.includes('--second');
const pagePort = second ? 5174 : 5173;
const backendPort = second ? 8081 : 8080;
const outfile = path.join(
  root,
  'worklet',
  second ? 'app.second.core.gen.js' : 'app.core.gen.js',
);
const require = createRequire(import.meta.url);
const bareExecutable = require('bare-runtime')();
// npm ci can leave the prebuilt runtime without its execute bit.
if (process.platform !== 'win32') fs.chmodSync(bareExecutable, 0o755);

// `mode=dev` selects the dev backend (auth off). The origins let the Vite dev
// server (pinned in vite.config.ts and above) open the protocol socket.
const appArgs = [
  'mode=dev',
  `origin=http://localhost:${pagePort}`,
  `origin=http://127.0.0.1:${pagePort}`,
  `storage=${path.join(root, '.dev-storage', second ? 'second' : 'first')}`,
  '--port',
  String(backendPort),
];

// The sync state writer does not create folders; without this a fresh clone
// joins a new room on every start.
fs.mkdirSync(path.join(root, '.dev-storage', second ? 'second' : 'first'), {
  recursive: true,
});

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

// The page reads this to find its backend (src/transport.ts).
process.env.VITE_BACKEND_PORT = String(backendPort);
const server = await createServer({
  root,
  server: { port: pagePort, strictPort: true },
});
try {
  await server.listen();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('in use') || message.includes('EADDRINUSE')) {
    console.log(
      `[vote] Port ${pagePort} is in use. Stop the other dev server and run it again.`,
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
  `vote ready: http://localhost:${pagePort} (browser only; the phone shows the last "npm run sync")`,
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
