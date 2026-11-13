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
const { logCommandTimes, joinFailed } = new Function(
  'fs',
  'path',
  `${pick(/function logCommandTimes[\s\S]*?\n}\n/)}
${pick(/function joinFailed[\s\S]*?\n}\n/)}
return { logCommandTimes, joinFailed };`,
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

test('any other failure is retried', () => {
  assert.equal(joinFailed(['tapOn Join the room FAILED']), true);
  assert.equal(joinFailed([]), true);
});
