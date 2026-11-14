// Run: node --test .github/scripts/starter-two-phones.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = fs.readFileSync(
  new URL('./starter-two-phones.mjs', import.meta.url),
  'utf8',
);
const pick = (re) => source.match(re)[0];
const { logCommandTimes, joinFailed, joinWithRetry, pickIphone } = new Function(
  'fs',
  'path',
  `${pick(/function logCommandTimes[\s\S]*?\n}\n/)}
${pick(/function joinFailed[\s\S]*?\n}\n/)}
${pick(/async function joinWithRetry[\s\S]*?\n}\n/)}
${pick(/function pickIphone[\s\S]*?\n}\n/)}
return { logCommandTimes, joinFailed, joinWithRetry, pickIphone };`,
)(fs, path);

test('a failed run keeps its screenshots and logs for the upload step', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-debug-'));
  const run = path.join(folder, 'One step of the two-phone walk');
  fs.mkdirSync(path.join(run, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(run, 'commands.json'),
    JSON.stringify([
      {
        command: {
          extendedWaitUntilCommand: { label: 'Phone sees the others' },
        },
        metadata: { status: 'FAILED', duration: 150000 },
      },
    ]),
  );
  fs.writeFileSync(path.join(run, 'logs', 'maestro.log'), 'log');
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  logCommandTimes(folder, 'emulator-5556', 'joinwait');
  console.log = log;
  assert.ok(fs.existsSync(path.join(run, 'logs', 'maestro.log')));
  assert.ok(fs.existsSync(path.join(run, 'commands.json')));
  assert.match(logged.join('\n'), /Phone sees the others: 150000 ms/);
});

test('a timeout on the wait for the other devices is not retried', () => {
  assert.equal(
    joinFailed(['assertCondition Phone sees the other devices 148289 FAILED']),
    false,
  );
});

test('a passed wait for the other devices is not a failed join', () => {
  assert.equal(
    joinFailed(['  Phone sees the other devices... COMPLETED']),
    true,
  );
});

test('any other failure is retried', () => {
  assert.equal(joinFailed(['tapOn Join the room FAILED']), true);
  assert.equal(joinFailed([]), true);
});

const attempts = (...results) => {
  const calls = [];
  return {
    calls,
    attempt: async () => {
      calls.push(1);
      return results[calls.length - 1];
    },
  };
};

test('a timeout on the wait for the other devices is not joined again', async () => {
  const a = attempts(
    { ok: false, lines: ['  Phone sees the other devices... FAILED'] },
    { ok: true, lines: [] },
  );
  assert.equal(await joinWithRetry(a.attempt), false);
  assert.equal(a.calls.length, 1);
});

test('a failed join is tried once more', async () => {
  const a = attempts(
    { ok: false, lines: ['  Join the room... FAILED'] },
    { ok: true, lines: [] },
  );
  assert.equal(await joinWithRetry(a.attempt), true);
  assert.equal(a.calls.length, 2);
});

test('a join that passes is not run again', async () => {
  const a = attempts({ ok: true, lines: [] });
  assert.equal(await joinWithRetry(a.attempt), true);
  assert.equal(a.calls.length, 1);
});

test('pickIphone takes the newest available iOS runtime and an iPhone type', () => {
  const list = {
    runtimes: [
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-17-5',
        version: '17.5',
        isAvailable: true,
      },
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
        version: '18.2',
        isAvailable: true,
      },
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
        version: '26.0',
        isAvailable: false,
      },
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0',
        version: '11.0',
        isAvailable: true,
      },
    ],
    devicetypes: [
      {
        identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro',
        name: 'iPad Pro',
      },
      {
        identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        name: 'iPhone 16',
      },
    ],
  };
  assert.deepEqual(pickIphone(list), {
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
  });
});

test('pickIphone skips a newer runtime that is not iOS', () => {
  const list = {
    runtimes: [
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-9-3',
        version: '9.3',
        isAvailable: true,
      },
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
        version: '26.0',
        isAvailable: true,
      },
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.xrOS-26-1',
        version: '26.1',
        isAvailable: true,
      },
    ],
    devicetypes: [
      {
        identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        name: 'iPhone 17',
      },
    ],
  };
  assert.equal(
    pickIphone(list).runtime,
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
  );
});
