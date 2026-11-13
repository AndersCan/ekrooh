#!/usr/bin/env node
/**
 * Two phones vote in sync: follows Start here's commands in order on a fresh
 * starter copy, with two Android emulators on this machine, and times every step.
 * `node .github/scripts/starter-two-phones.mjs <fresh starter copy> [--topology H|P]`
 *   H (default): both phones join the browser page's room (Start here's paste step).
 *   P: phone B joins phone A's room, no browser.
 * Steps 4-6 stand in for Android Studio (Gradle sync, Device Manager, Run); the
 * paste is typed through Maestro. Needs `maestro`, `adb`, `avdmanager` on PATH,
 * ANDROID_HOME, system image `system-images;android-35;default;x86_64`,
 * and `npm ci` + `npm run playwright:install` at the repo root.
 * Prints `step <n> <name>: <s> s (doc|stand-in)` and `total <s> s of 300`, and
 * writes the same table to $GITHUB_STEP_SUMMARY. A total over 300 s only warns.
 * Set WALK_GET_SECONDS to the seconds the degit or cp step took.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

// Budgets in seconds. Every wait is on what a process or page shows, never a sleep.
const INSTALL = 240;
const SYNC = 120;
const READY = 120;
const BUILD = 600;
const BOOT = 360;
const APK = 60;
const CODE = 150;
const JOIN = 240;
const VOTE = 300;
const GOAL = 300;
const KILL_GRACE_MS = 5000;
const LOG_LINES = 40;
const SERIALS = ['emulator-5554', 'emulator-5556'];
// AOSP image. Hypothesis, not proven: with google_apis, Play services churn at boot and adb drops the phone as `device offline` under Maestro's launch; the default image has no Play services.
const IMAGE = 'system-images;android-35;default;x86_64';
const APP = 'com.example.vote';

function usage(message) {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
const topologyAt = args.indexOf('--topology');
const topology = topologyAt === -1 ? 'H' : args.splice(topologyAt, 2)[1];
const dir = args[0] ? path.resolve(args[0]) : null;
if (!dir || !['H', 'P'].includes(topology)) {
  usage(
    'usage: node .github/scripts/starter-two-phones.mjs <starter-dir> [--topology H|P]',
  );
}
if (!fs.existsSync(path.join(dir, 'package.json'))) {
  usage(`${dir} has no package.json: pass a fresh copy of the starter`);
}
if (fs.existsSync(path.join(dir, '.dev-storage'))) {
  usage(
    `${dir}/.dev-storage exists: the walk needs fresh devices; use a fresh copy of the starter`,
  );
}
const onPath = (name) =>
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((entry) => entry && fs.existsSync(path.join(entry, name)));
for (const [name, hint] of [
  ['maestro', 'install Maestro 2.12.1'],
  ['adb', 'install the Android platform-tools'],
  ['avdmanager', 'install the Android command-line tools'],
]) {
  if (!onPath(name)) usage(`${name} not found: ${hint}`);
}
const sdk = process.env.ANDROID_HOME;
if (!sdk) usage('ANDROID_HOME is not set');
const emulatorBin = path.join(sdk, 'emulator', 'emulator');
if (!fs.existsSync(emulatorBin)) usage(`emulator not found at ${emulatorBin}`);
if (!fs.existsSync(path.join(sdk, ...IMAGE.split(';')))) {
  usage(`system image ${IMAGE} is not installed: sdkmanager "${IMAGE}"`);
}
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
let browser;
try {
  browser = await chromium.launch();
} catch {
  usage('Chromium not installed: run npm run playwright:install');
}

const rows = [];
const getSeconds = Number(process.env.WALK_GET_SECONDS);
if (Number.isFinite(getSeconds) && getSeconds > 0) {
  rows.push({
    n: 0,
    name: 'get the starter (degit)',
    s: getSeconds,
    kind: 'doc',
  });
  console.log(`step 0 get the starter (degit): ${getSeconds} s (doc)`);
}
const startedAt = Date.now();
let stepStart = Date.now();
let current = { n: 0, name: 'start', wanted: '' };

function begin(n, name, kind, wanted) {
  current = { n, name, kind, wanted };
  stepStart = Date.now();
}

function done() {
  const s = Math.round((Date.now() - stepStart) / 1000);
  rows.push({ n: current.n, name: current.name, s, kind: current.kind });
  console.log(`step ${current.n} ${current.name}: ${s} s (${current.kind})`);
}

const tail = (lines, count) => lines.slice(-count).join('\n');

function lineBuffer(stream, lines) {
  readline.createInterface({ input: stream }).on('line', (l) => lines.push(l));
}

function run(command, commandArgs, options = {}) {
  const lines = [];
  const child = spawn(command, commandArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  const state = { child, lines, exit: null };
  lineBuffer(child.stdout, lines);
  lineBuffer(child.stderr, lines);
  child.on('exit', (code, signal) => {
    state.exit = code ?? signal;
  });
  child.on('error', (error) => {
    lines.push(String(error));
    state.exit = 'error';
  });
  return state;
}

// Playwright's connectOverCDP refuses Android WebView (no Browser context
// management), so talk to the page's debug socket directly.
function evaluateOverCdp(url, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('cdp: evaluate timed out'));
    }, 3000);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }),
      );
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      resolve(message.result?.result?.value ?? '');
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('cdp: socket error'));
    };
  });
}

async function until(check, budget) {
  const deadline = Date.now() + budget * 1000;
  while (Date.now() < deadline) {
    if (await check()) return true;
    // Gap between two checks of what a process shows; not a wait for a result.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  // Kill timer: gives the child a moment to stop, then forces it.
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

// Runs a command to completion inside the current step's budget.
async function finish(state, budget, what) {
  const ok = await until(() => state.exit !== null, budget);
  if (!ok) {
    await stop(state.child);
    current.wanted = `${what} (not done in ${budget} s)`;
    return false;
  }
  if (state.exit !== 0) {
    current.wanted = `${what} (exit ${state.exit})`;
    return false;
  }
  return true;
}

const adb = (serial, ...rest) =>
  spawnSync('adb', ['-s', serial, ...rest], { encoding: 'utf8' });

const emulators = [];
let server = null;
const maestroLines = [];
const notes = [];
const debugOutput = path.join(
  process.env.RUNNER_TEMP || os.tmpdir(),
  'maestro-debug',
);

// Prints how long each Maestro command took, from one run's debug folder.
// Reads only; the folder stays for the upload step of a failed job.
function logCommandTimes(folder, serial, act) {
  try {
    const files = [
      folder,
      ...fs.readdirSync(folder).map((n) => path.join(folder, n)),
    ]
      .map((d) => path.join(d, 'commands.json'))
      .filter((f) => fs.existsSync(f));
    for (const file of files) {
      for (const entry of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        const body = Object.values(entry.command ?? {})[0] ?? {};
        const ms = entry.metadata?.duration;
        if (body.label && ms !== undefined)
          console.log(`    ${act} ${serial} ${body.label}: ${ms} ms`);
      }
    }
  } catch {
    // No timing file: the timing is a log, not a check.
  }
}

// A timeout on the wait for the other devices is not a failed join: a second Join would only wait again.
function joinFailed(lines) {
  return !lines.some((l) => /Phone sees the other devices.*FAILED/.test(l));
}

let maestroRuns = 0;
async function maestro(serial, act, env = {}) {
  const flags = Object.entries({ ACT: act, ...env }).flatMap(([k, v]) => [
    '-e',
    `${k}=${v}`,
  ]);
  const folder = path.join(debugOutput, serial, `${++maestroRuns}-${act}`);
  const state = run('maestro', [
    '--device',
    serial,
    'test',
    '--debug-output',
    folder,
    '--flatten-debug-output',
    ...flags,
    path.join(root, '.github/scripts/starter-two-phones.yaml'),
  ]);
  const ok = await finish(state, VOTE, `maestro ${act} on ${serial}`);
  maestroLines.push(`--- ${act} on ${serial} ---`, ...state.lines);
  logCommandTimes(folder, serial, act);
  return { ok, lines: state.lines };
}

async function walk() {
  begin(1, 'npm install', 'doc', 'npm install to finish');
  if (!(await finish(run('npm', ['ci'], { cwd: dir }), INSTALL, 'npm install')))
    return false;
  done();

  begin(2, 'npm run sync', 'doc', 'npm run sync to finish');
  if (
    !(await finish(
      run('npm', ['run', 'sync'], { cwd: dir }),
      SYNC,
      'npm run sync',
    ))
  )
    return false;
  done();

  begin(3, 'npm run dev', 'doc', 'the dev server to print "vote ready:"');
  // Runs the dev script directly: npm does not pass SIGTERM on to it.
  server = run('node', ['scripts/dev.mjs'], { cwd: dir });
  server.ready = false;
  readline.createInterface({ input: server.child.stdout }).on('line', (l) => {
    if (l.includes('vote ready:')) server.ready = true;
  });
  if (
    !(await until(() => server.ready || server.exit !== null, READY)) ||
    server.exit !== null
  )
    return false;
  done();

  begin(
    4,
    'gradle build (Studio sync + Run build)',
    'stand-in',
    './gradlew assembleDebug to finish',
  );
  const gradle = run('./gradlew', ['assembleDebug'], {
    cwd: path.join(dir, 'android'),
  });
  if (!(await finish(gradle, BUILD, 'assembleDebug'))) {
    maestroLines.push('--- gradle ---', ...gradle.lines);
    return false;
  }
  // The Gradle daemon would hold memory the second emulator needs.
  spawnSync('./gradlew', ['--stop'], { cwd: path.join(dir, 'android') });
  done();

  begin(
    5,
    'create and boot two emulators (Device Manager)',
    'stand-in',
    'both emulators to finish booting',
  );
  for (const [i, serial] of SERIALS.entries()) {
    const name = `phone${i}`;
    const created = spawnSync(
      'avdmanager',
      ['create', 'avd', '-n', name, '-k', IMAGE, '-d', 'pixel', '--force'],
      { input: 'no\n', encoding: 'utf8' },
    );
    if (created.status !== 0) {
      current.wanted = `avdmanager create ${name}: ${created.stderr || created.stdout}`;
      return false;
    }
    emulators.push(
      run(emulatorBin, [
        '-avd',
        name,
        '-port',
        serial.split('-')[1],
        '-no-window',
        '-no-audio',
        '-no-boot-anim',
        '-gpu',
        'swiftshader_indirect',
        '-no-snapshot',
        '-cores',
        '2',
        '-memory',
        '2560',
      ]),
    );
  }
  const booted = await until(
    () =>
      SERIALS.every(
        (serial) =>
          adb(
            serial,
            'shell',
            'getprop',
            'sys.boot_completed',
          ).stdout.trim() === '1',
      ),
    BOOT,
  );
  if (!booted) return false;
  for (const serial of SERIALS) {
    for (const key of [
      'window_animation_scale',
      'transition_animation_scale',
      'animator_duration_scale',
    ]) {
      adb(serial, 'shell', 'settings', 'put', 'global', key, '0');
    }
  }
  done();

  begin(
    6,
    'install the app on both (Run)',
    'stand-in',
    'the app to install on both emulators',
  );
  const apk = path.join(
    dir,
    'android/app/build/outputs/apk/debug/app-debug.apk',
  );
  for (const serial of SERIALS) {
    const installed = await finish(
      run('adb', ['-s', serial, 'install', '-r', apk]),
      APK,
      `install on ${serial}`,
    );
    if (!installed) return false;
    // Run also opens the app; opening it here lets the page settle while the walk goes on.
    adb(
      serial,
      'shell',
      'monkey',
      '-p',
      APP,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    );
  }
  done();

  const [phoneA, phoneB] = SERIALS;
  let invite = '';
  begin(
    7,
    'read the invite code (copy)',
    'doc',
    'an invite code of 32 lowercase hex characters',
  );
  if (topology === 'H') {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('http://localhost:5173');
    const read = async () =>
      (
        (await page
          .locator('code.invite')
          .first()
          .textContent({ timeout: 1000 })
          .catch(() => '')) ?? ''
      ).trim();
    await until(async () => /^[0-9a-f]{32}$/.test(await read()), CODE);
    invite = await read();
    // Free the runner's CPU: the open page keeps reloading and a phone went offline.
    await context.close();
  } else {
    // Phone A's own code, read from its page over the WebView debug socket.
    const read = async () => {
      const sockets = adb(phoneA, 'shell', 'cat', '/proc/net/unix').stdout;
      const socket = (sockets.match(/@(webview_devtools_remote_\d+)/) ?? [])[1];
      if (!socket) {
        notes.push(
          `no webview socket; pid ${adb(phoneA, 'shell', 'pidof', 'com.example.vote').stdout.trim() || 'none'}`,
        );
        return '';
      }
      adb(phoneA, 'forward', 'tcp:9222', `localabstract:${socket}`);
      try {
        const targets = await (
          await fetch('http://127.0.0.1:9222/json', {
            signal: AbortSignal.timeout(3000),
          })
        ).json();
        const target = targets.find((t) => t.webSocketDebuggerUrl);
        if (!target) {
          notes.push('cdp: no page target');
          return '';
        }
        const text = await evaluateOverCdp(
          target.webSocketDebuggerUrl,
          "document.querySelector('code.invite')?.textContent ?? ''",
        );
        return String(text).trim();
      } catch (error) {
        notes.push(`cdp: ${String(error.message).split('\n')[0]}`);
        return '';
      }
    };
    await until(async () => /^[0-9a-f]{32}$/.test(await read()), CODE);
    invite = await read();
  }
  if (!/^[0-9a-f]{32}$/.test(invite)) return false;
  done();

  begin(
    8,
    'paste the code and Join (paste + Join)',
    'doc',
    'the last phone to join and show the others connected',
  );
  const joiners = topology === 'H' ? [phoneA, phoneB] : [phoneB];
  const lapStart = Date.now();
  const lap = (what) =>
    console.log(
      `  step 8 ${what}: ${Math.round((Date.now() - lapStart) / 1000)} s in`,
    );
  // One phone after the other: the second looks the room up after the first has
  // announced it. Joined at the same moment, the phones can miss each other.
  const expect =
    topology === 'H' ? '2 other devices connected' : '1 other device connected';
  for (const [index, serial] of joiners.entries()) {
    // A cold phone sometimes fails its first Maestro launch; the join gets one retry.
    adb(serial, 'reconnect', 'offline');
    adb(serial, 'wait-for-device');
    // The last phone to join also waits to see the others: one Maestro start, not two.
    const act = index === joiners.length - 1 ? 'joinwait' : 'join';
    const env = { INVITE: invite, EXPECT: expect };
    const first = await maestro(serial, act, env);
    const joined =
      first.ok ||
      (joinFailed(first.lines) && (await maestro(serial, act, env)).ok);
    lap(`${serial} ${act === 'joinwait' ? `shows "${expect}"` : 'joined'}`);
    if (!joined) {
      current.wanted = `${serial} to join and show "${expect}"`;
      return false;
    }
  }
  done();

  begin(
    9,
    'vote Tea on A, B shows Tea (1) (vote)',
    'doc',
    'phone B to show Tea (1)',
  );
  // B's Maestro starts now so its startup overlaps A's vote; A's run also checks A sees B.
  const seen = maestro(phoneB, 'see');
  const voted = await maestro(phoneA, 'vote', { EXPECT: expect });
  if (voted.ok) console.log('phone A shows Tea (1)');
  const seenOk = (await seen).ok;
  if (seenOk) console.log('phone B shows Tea (1)');
  if (!voted.ok || !seenOk) {
    current.wanted = `A to show "${expect}" and Tea (1), B to show Tea (1)`;
    return false;
  }
  done();
  return true;
}

const result = await walk().catch((error) => {
  current.wanted = `${current.wanted} (${String(error.message).split('\n')[0]})`;
  return false;
});

const total =
  Math.round((Date.now() - startedAt) / 1000) +
  (rows[0]?.n === 0 ? rows[0].s : 0);
const table = [
  `Two phones, topology ${topology}`,
  '',
  '| step | name | seconds | kind |',
  '| --- | --- | ---: | --- |',
  ...rows.map((r) => `| ${r.n} | ${r.name} | ${r.s} | ${r.kind} |`),
  `| | **total (goal ${GOAL})** | **${total}** | |`,
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);

if (result) {
  console.log(`total ${total} s of ${GOAL} (stand-in steps: 4,5,6)`);
  if (total > GOAL)
    console.log(`::warning::Two-phone walk took ${total} s, over ${GOAL} s`);
  console.log('two phones: PASS');
} else {
  console.error(
    `two phones: FAIL at step ${current.n} ${current.name} after ${total} s: ${current.wanted}`,
  );
  for (const serial of SERIALS) {
    const log = adb(serial, 'logcat', '-d').stdout ?? '';
    const lines = log.split('\n').filter((l) => /\[(sync|vote)\]/.test(l));
    console.error(
      `--- ${serial} [sync]/[vote] logcat (last ${LOG_LINES}) ---\n${tail(lines, LOG_LINES)}`,
    );
  }
  console.error(`--- notes ---\n${tail(notes, LOG_LINES)}`);
  console.error(
    `--- maestro (last ${LOG_LINES} lines) ---\n${tail(maestroLines, LOG_LINES)}`,
  );
  for (const [index, emulator] of emulators.entries()) {
    console.error(
      `--- emulator ${index} output (last ${LOG_LINES} lines) ---\n${tail(emulator.lines, LOG_LINES)}`,
    );
  }
  if (server)
    console.error(
      `--- npm run dev (last ${LOG_LINES} lines) ---\n${tail(server.lines, LOG_LINES)}`,
    );
}

for (const serial of SERIALS) adb(serial, 'emu', 'kill');
for (const emulator of emulators) await stop(emulator.child);
await browser.close().catch(() => {});
if (server) await stop(server.child);
process.exit(result ? 0 : 1);
