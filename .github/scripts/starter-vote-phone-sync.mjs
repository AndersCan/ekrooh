#!/usr/bin/env node
/**
 * Phone votes, second peer sees it: starts a second copy of the vote starter on
 * this machine (`node scripts/dev.mjs --second`, read with headless Chromium),
 * has the debug app on a booted phone or Simulator join its room by invite code
 * through Maestro, vote Tea, and passes only when the second peer shows Tea (1).
 * CI runs it in Starter / android and Starter / ios; by hand:
 * `node .github/scripts/starter-vote-phone-sync.mjs <fresh starter copy> [--device <id>]`
 * with the debug app installed, `maestro` on PATH, `npm ci` and
 * `npm run playwright:install` at the repo root and `npm ci` in the copy. It
 * reads the starter's visible text (button names, Join box label): renaming
 * those means updating this file and starter-vote-native-sync.yaml.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

// Budgets in seconds. Every wait is on what the page or a process shows, never a sleep.
const START = 60;
const READY = 60;
const ANNOUNCED = 30;
// iOS driver startup 2 x 180 (MAESTRO_DRIVER_STARTUP_TIMEOUT) + flow waits ~120.
const PHONE = 480;
// Tries at starting Maestro's iOS driver (the workflow gives each 180 s).
const DRIVER_ATTEMPTS = 2;
// The web journey's CONNECTED 120 + SYNCED 30.
const SYNCED = 150;
const OVERALL = 800; // START + READY + ANNOUNCED + PHONE + SYNCED = 780 s
const KILL_GRACE_MS = 5000;
const LOG_LINES = 60;
const MAESTRO_LINES = 40;

const port = 5174;
function usage(message) {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
const deviceAt = args.indexOf('--device');
const device = deviceAt === -1 ? null : args.splice(deviceAt, 2)[1];
const dir = args[0];
if (
  !dir ||
  (deviceAt !== -1 && !device) ||
  !fs.existsSync(path.join(dir, 'package.json'))
) {
  usage(
    'usage: node .github/scripts/starter-vote-phone-sync.mjs <starter-dir> [--device <id>]',
  );
}
if (fs.existsSync(path.join(dir, '.dev-storage'))) {
  usage(
    `${dir}/.dev-storage exists: the check needs fresh devices; use a fresh copy of the starter`,
  );
}
const maestroFound = (process.env.PATH ?? '')
  .split(path.delimiter)
  .some((entry) => entry && fs.existsSync(path.join(entry, 'maestro')));
if (!maestroFound) usage('maestro not found: install Maestro 2.12.1');

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(
  root,
  '.playwright-browsers',
);
let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  usage('Playwright not found: run npm ci at the repo root');
}
let Hyperswarm;
try {
  ({ default: Hyperswarm } = await import('hyperswarm'));
} catch {
  usage('hyperswarm not found: run npm ci at the repo root');
}
// Before any server starts, so a missing browser is a usage error.
let browser;
try {
  browser = await chromium.launch();
} catch {
  usage('Chromium not installed: run npm run playwright:install');
}

const startedAt = Date.now();
const seconds = () => Math.round((Date.now() - startedAt) / 1000);
let stage;
let wanted;
let stageStartedAt;

function begin(name, what) {
  stage = name;
  wanted = what;
  stageStartedAt = Date.now();
}

function passed() {
  const took = Math.round((Date.now() - stageStartedAt) / 1000);
  console.log(`ok ${stage} (${took} s)`);
}

// Runs the dev script directly: npm does not pass SIGTERM on to it, which
// would leave the dev server and Bare running after the journey.
function startServer(args) {
  const lines = [];
  const child = spawn('node', ['scripts/dev.mjs', ...args], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, lines, exited: null, ready: false };
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => {
      lines.push(line);
      if (line.includes('vote ready:')) state.ready = true;
    });
  }
  child.on('exit', (code, signal) => {
    state.exited = `exit code ${code ?? signal}`;
  });
  return state;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  // Kill timer: gives the child a moment to stop, then forces it.
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  await done;
  clearTimeout(timer);
}

async function until(check, budget) {
  const deadline = Date.now() + budget * 1000;
  while (Date.now() < deadline) {
    if (await check()) return true;
    // Gap between two checks of what the pages show; not a wait for a result.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function roomFound(room) {
  const swarm = new Hyperswarm();
  swarm.on('error', () => {});
  try {
    const topic = crypto
      .createHash('sha256')
      .update(`ekrooh/sync/v1\n${room}`)
      .digest();
    const deadline = Date.now() + ANNOUNCED * 1000;
    while (Date.now() < deadline) {
      for await (const result of swarm.dht.lookup(topic)) {
        if (result.peers.length > 0) return true;
      }
    }
    return false;
  } finally {
    await swarm.destroy();
  }
}

const server = startServer(['--second']);
let page = null;
const pageErrors = [];
let maestro = null;
const maestroLines = [];

async function pageText() {
  if (!page) return '(no page yet)';
  try {
    const text = await page.locator('#app').innerText({ timeout: 2000 });
    return text.replace(/\s*\n\s*/g, ' | ');
  } catch {
    return '(page not readable)';
  }
}

async function fail() {
  const failedStage = stage;
  const second = await pageText();
  const tail = (lines, count) => lines.slice(-count).join('\n');
  console.error(
    `phone sync: FAIL at ${failedStage} after ${seconds()} s: ${wanted}\n` +
      `second peer page (${port}): ${second}\n` +
      `page errors: ${pageErrors.length ? pageErrors.join(' ; ') : 'none'}\n` +
      `--- maestro (last ${MAESTRO_LINES} lines) ---\n${tail(maestroLines, MAESTRO_LINES)}\n` +
      `--- node scripts/dev.mjs --second (last ${LOG_LINES} lines) ---\n${tail(server.lines, LOG_LINES)}`,
  );
}

async function buttonShown(name) {
  return page
    .getByRole('button', { name, exact: true })
    .isVisible()
    .catch(() => false);
}

async function textOf(locator) {
  return (
    (await locator
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => '')) ?? ''
  );
}

async function run() {
  begin('start', 'the second peer to print "vote ready:"');
  const started = await until(() => server.ready || server.exited, START);
  if (server.exited) {
    wanted = `the second peer to keep running (${server.exited})`;
    return false;
  }
  if (!started) return false;
  passed();

  begin('ready', 'the second peer page to show Tea (0) and an invite code');
  page = await (await browser.newContext()).newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`http://localhost:${port}`);
  const invite = () => textOf(page.locator('code.invite'));
  const ready = await until(
    async () =>
      (await buttonShown('Tea (0)')) && (await invite()).trim() !== '',
    READY,
  );
  if (!ready) return false;
  passed();

  // A device that joins a room before the other device's announce reaches the
  // DHT never finds it (the next lookup is 10+ minutes away), so wait until
  // the room can be looked up.
  begin('announced', "the second peer's room to be found on the DHT");
  const code = (await invite()).trim();
  if (!(await roomFound(code))) return false;
  passed();

  begin('phone', 'the phone to join and show Tea (1)');
  const debugOutput = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    'maestro-debug',
  );
  // A slow Simulator sometimes never brings Maestro's iOS driver up; the flow
  // has not started then, so one more attempt is safe.
  let maestroExit = null;
  for (let attempt = 1; attempt <= DRIVER_ATTEMPTS; attempt++) {
    maestroExit = null;
    maestroLines.length = 0;
    maestro = spawn(
      'maestro',
      [
        ...(device ? ['--device', device] : []),
        'test',
        '--debug-output',
        debugOutput,
        '--flatten-debug-output',
        '-e',
        `INVITE=${code}`,
        path.join(root, '.github/scripts/starter-vote-native-sync.yaml'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    maestro.on('exit', (exitCode, signal) => {
      maestroExit = exitCode ?? signal;
    });
    for (const stream of [maestro.stdout, maestro.stderr]) {
      readline
        .createInterface({ input: stream })
        .on('line', (line) => maestroLines.push(line));
    }
    if (!(await until(() => maestroExit !== null, PHONE))) return false;
    const driverDown = maestroLines.some((line) =>
      line.includes('driver not ready in time'),
    );
    if (maestroExit === 0 || !driverDown) break;
  }
  if (maestroExit !== 0) {
    wanted = `the phone to join and show Tea (1) (maestro exit ${maestroExit})`;
    return false;
  }
  passed();

  begin(
    'synced',
    'the second peer page to show Tea (1), Coffee (0), Water (0)',
  );
  const synced = await until(async () => {
    for (const name of ['Tea (1)', 'Coffee (0)', 'Water (0)']) {
      if (!(await buttonShown(name))) return false;
    }
    return true;
  }, SYNCED);
  if (!synced) return false;
  passed();
  return true;
}

// Overall cap: fail at whatever stage is current.
const result = await Promise.race([
  run().catch((error) => {
    wanted = `${wanted} (${error.message.split('\n')[0]})`;
    return false;
  }),
  new Promise((resolve) => setTimeout(() => resolve(false), OVERALL * 1000)),
]);

if (result) console.log('phone sync: PASS');
else await fail();

if (maestro) await stop(maestro);
await browser?.close().catch(() => {});
await stop(server.child);
process.exit(result ? 0 : 1);
