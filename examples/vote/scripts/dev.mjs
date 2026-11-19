#!/usr/bin/env node
/**
 * `npm run dev`: bundles and runs the app backend (worklet) under Bare and
 * serves the page with Vite, in one process.
 */
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createBundleRoute } from './worklet-bundle.mjs';

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
let server = null;
let restartChain = Promise.resolve();

function stopBare() {
  return new Promise((resolve) => {
    if (!bareProcess) return resolve();
    const processToStop = bareProcess;
    if (processToStop.exitCode !== null || processToStop.signalCode !== null) {
      bareProcess = null;
      return resolve();
    }
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
  const portTaken = await portAnswers();
  bareProcess = spawn(bareExecutable, [outfile, ...appArgs], {
    stdio: 'inherit',
  });
  if (portTaken) return;
  void announceWhenReady(bareProcess, Date.now());
}

/** Reloads browser pages once this backend answers, unless a newer one replaced it. */
async function announceWhenReady(child, started) {
  if (await backendAnswers(child)) {
    console.log(
      `[vote] worklet running on this computer (${((Date.now() - started) / 1000).toFixed(1)} s)`,
    );
    // Browser pages reload; pages in a debug app (?backend=) ignore this.
    if (!shuttingDown)
      server?.ws.send({ type: 'custom', event: 'vote:worklet' });
  }
}

/** True when something already listens on the backend port. */
function portAnswers() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: backendPort });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** True once the backend accepts connections; false if it exits or 15 s pass. */
async function backendAnswers(child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (
      child !== bareProcess ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return false;
    if (await portAnswers()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// The Android debug app fetches the packed worklet from the dev server.
const bundleRoute = createBundleRoute();
const packedAndroid = path.join(
  root,
  '.dev-storage',
  'worklet',
  'android.bundle',
);
let packChain = Promise.resolve();

/** Packs the built worklet for Android and publishes it; keeps the old one on failure. */
function packAndroid() {
  packChain = packChain.then(
    () =>
      new Promise((resolve) => {
        fs.mkdirSync(path.dirname(packedAndroid), { recursive: true });
        const child = spawn(
          process.execPath,
          [
            path.join(root, 'node_modules', 'bare-pack', 'bin.js'),
            '--preset',
            'android',
            '--out',
            packedAndroid,
            outfile,
          ],
          { cwd: root, stdio: 'inherit' },
        );
        child.once('error', () => resolve());
        child.once('exit', (code) => {
          if (code === 0) bundleRoute.set(fs.readFileSync(packedAndroid));
          resolve();
        });
      }),
  );
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
          if (result.errors.length === 0) {
            scheduleRestart();
            if (!second) packAndroid();
          } else
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
server = await createServer({
  root,
  // 127.0.0.1: the Android emulator reaches this computer's 127.0.0.1 as 10.0.2.2.
  // The port must match DEV_SERVER_URL in android/app/build.gradle.
  server: { host: '127.0.0.1', port: pagePort, strictPort: true },
  plugins: second
    ? []
    : [
        {
          name: 'worklet-bundle',
          // Before Vite's own middlewares, so the page fallback never answers it.
          configureServer: (viteServer) =>
            void viteServer.middlewares.use(bundleRoute.handle),
        },
      ],
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
  `vote ready: http://localhost:${pagePort} (browser)${second ? '' : ` and http://10.0.2.2:${pagePort} (Android emulator debug app)`}`,
);
console.log(
  'Saving worklet/ restarts the app backend on this computer and reloads browser pages (votes start from zero). A new native package needs npm run sync.',
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
