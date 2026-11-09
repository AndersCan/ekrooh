#!/usr/bin/env node
/**
 * Android reload: runs the debug vote app on a booted emulator with
 * `npm run dev` running, votes Tea, edits src/render.ts and passes only when the
 * emulator shows Tea [1] (page from the dev server, reloaded on save, vote kept).
 * CI runs it in the Starter / android reload job; by hand: boot an emulator, put
 * adb on PATH, `npm ci` at the repo root, `npm ci && npm run sync` and
 * `cd android && ./gradlew assembleDebug` in a fresh starter copy, then
 * `node .github/scripts/starter-android-reload.mjs <starter dir>`.
 * It reads the starter's button names: renaming them means updating this file.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

// Budgets in seconds. Every wait is on what the page shows, never a sleep.
const DEV = 90;
const INSTALL = 120;
const ATTACH = 120;
const DEVPAGE = 60;
const VOTE = 15;
const RELOAD = 20;
const OVERALL = 430; // the budgets above add up to 425 s
const KILL_GRACE_MS = 5000;
const LOG_LINES = 60;
const PKG = 'com.example.vote';

function usage(message) {
  console.error(message);
  process.exit(2);
}

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'package.json'))) {
  usage('usage: node .github/scripts/starter-android-reload.mjs <starter-dir>');
}
const apk = path.join(dir, 'android/app/build/outputs/apk/debug/app-debug.apk');
if (!fs.existsSync(apk)) usage(`${apk} not found: run assembleDebug first`);
let _android;
try {
  ({ _android } = await import('@playwright/test'));
} catch {
  usage('Playwright not found: run npm ci at the repo root');
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

async function until(check, budget) {
  const deadline = Date.now() + budget * 1000;
  while (Date.now() < deadline) {
    if (await check()) return true;
    // Gap between two checks of what the page shows; not a wait for a result.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// Runs the dev script directly: npm does not pass SIGTERM on to it, which
// would leave the dev server and Bare running after the check.
const lines = [];
const server = { exited: /** @type {string | null} */ (null), ready: false };
const child = spawn('node', ['scripts/dev.mjs'], {
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [child.stdout, child.stderr]) {
  readline.createInterface({ input: stream }).on('line', (line) => {
    lines.push(line);
    if (line.includes('vote ready:')) server.ready = true;
  });
}
child.on('exit', (code, signal) => {
  server.exited = `exit code ${code ?? signal}`;
});

async function stopServer() {
  if (server.exited) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  await done;
  clearTimeout(timer);
}

const adb = (...args) =>
  execFileSync('adb', args, { encoding: 'utf8', timeout: INSTALL * 1000 });
let page = null;

async function buttonShown(name) {
  return page
    .getByRole('button', { name, exact: true })
    .isVisible()
    .catch(() => false);
}

async function run() {
  begin('dev', '"npm run dev" to print "vote ready:"');
  const up = await until(() => server.ready || server.exited, DEV);
  if (server.exited) {
    wanted = `the dev server to keep running (${server.exited})`;
    return false;
  }
  if (!up) return false;
  passed();

  begin('install', 'the debug APK to install and start');
  adb('install', '-r', apk);
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  passed();

  begin('attach', 'Playwright to read the debug WebView');
  let device;
  const attached = await until(async () => {
    try {
      [device] = await _android.devices();
      if (!device) return false;
      const webView = await device.webView({ pkg: PKG }, { timeout: 2000 });
      page = await webView.page();
      return true;
    } catch {
      return false;
    }
  }, ATTACH);
  if (!attached) return false;
  passed();

  begin('devpage', 'the page from http://10.0.2.2:5173/ showing Tea (0)');
  const shown = await until(
    async () =>
      page.url().startsWith('http://10.0.2.2:5173/') &&
      (await buttonShown('Tea (0)')),
    DEVPAGE,
  );
  if (!shown) return false;
  passed();

  begin('vote', 'Tea (1) after one click');
  await page.getByRole('button', { name: 'Tea (0)', exact: true }).click();
  if (!(await until(() => buttonShown('Tea (1)'), VOTE))) return false;
  passed();

  begin('reload', 'Tea [1] on the emulator after saving src/render.ts');
  const file = path.join(dir, 'src/render.ts');
  const before = '`${option.label} (${option.votes})`';
  const source = fs.readFileSync(file, 'utf8');
  if (source.split(before).length !== 2) {
    wanted = `${before} exactly once in src/render.ts`;
    return false;
  }
  fs.writeFileSync(
    file,
    source.replace(before, () => '`${option.label} [${option.votes}]`'),
  );
  // Fresh read of the page each poll: a full reload replaces the document.
  if (!(await until(() => buttonShown('Tea [1]'), RELOAD))) return false;
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

if (result) {
  console.log('starter android reload: PASS');
} else {
  let pageText = '(no page yet)';
  if (page) {
    pageText = await page
      .locator('#app')
      .innerText({ timeout: 2000 })
      .then((text) => text.replace(/\s*\n\s*/g, ' | '))
      .catch(() => '(page not readable)');
  }
  let logcat = '(adb logcat failed)';
  try {
    logcat = adb('logcat', '-d', '-s', 'BARE_KOTLIN:*', 'chromium:*', '*:E')
      .split('\n')
      .slice(-LOG_LINES)
      .join('\n');
  } catch {}
  console.error(
    `starter android reload: FAIL at ${stage} after ${seconds()} s: ${wanted}\n` +
      `page: ${pageText}\n` +
      `--- logcat (last ${LOG_LINES} lines) ---\n${logcat}\n` +
      `--- node scripts/dev.mjs (last ${LOG_LINES} lines) ---\n${lines.slice(-LOG_LINES).join('\n')}`,
  );
}

await stopServer();
process.exit(result ? 0 : 1);
