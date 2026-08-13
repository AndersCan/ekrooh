#!/usr/bin/env node
/**
 * Boots the multi-instance harness (ticket #21) for Playwright's webServer.
 * Assumes `core/harness.core.gen.js` (build:harness) and the built web assets
 * (build:web) already exist — `npm run harness:e2e` chains those builds.
 *
 * Runs the bare harness worklet with `<webAssets> <baseDir> <port>`; the port
 * pins the management server so Playwright can poll `/health`. Stale instance
 * dirs from a previous run are wiped at boot. The bare child's output is teed
 * to `harness.{stdout,stderr}.log` so a crash under a Playwright-managed run
 * is diagnosable (Playwright swallows webServer output once ready).
 */
import { spawn } from 'node:child_process';
import { openSync, writeSync, rmSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bareExecutable = require('bare-runtime')();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, 'core', 'harness.core.gen.js');
const webAssets = path.join(
  root,
  'examples',
  'android-app',
  'src',
  'main',
  'assets',
);
const baseDir = path.join(root, '.harness-instances');
const port = process.env.HARNESS_PORT ?? '8081';

rmSync(baseDir, { recursive: true, force: true });
mkdirSync(baseDir, { recursive: true });

const stdoutLog = openSync(path.join(baseDir, 'harness.stdout.log'), 'a');
const stderrLog = openSync(path.join(baseDir, 'harness.stderr.log'), 'a');
const debugLog = openSync(path.join(baseDir, 'harness.run.log'), 'a');
const stamp = () => new Date().toISOString();
const dbg = (message) => {
  try {
    writeSync(debugLog, `${stamp()} ${message}\n`);
  } catch {
    // best-effort logging
  }
};

dbg(`starting: bare=${bareExecutable} entry=${entry} port=${port}`);

const child = spawn(bareExecutable, [entry, webAssets, baseDir, port], {
  stdio: ['inherit', stdoutLog, stderrLog],
});
dbg(`spawned pid=${child.pid}`);

child.on('error', (err) => {
  dbg(`bare spawn error: ${err.message}`);
  console.error(`[harness:e2e] failed to start bare: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  dbg(`bare exited (code=${code}, signal=${signal ?? 'none'})`);
  console.log(
    `[harness:e2e] bare exited (code=${code}, signal=${signal ?? 'none'})`,
  );
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
