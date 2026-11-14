import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync(
  new URL('./starter-two-phones.mjs', import.meta.url),
  'utf8',
);
const body = source.match(/function startBoot[\s\S]*?\n}\n/)[0];
const load = (simctl, run) =>
  new Function('simctl', 'run', `${body}\nreturn startBoot;`)(simctl, run);

test('each Simulator is booted, then logs its own boot time when its bootstatus exits', () => {
  const calls = [];
  const children = [];
  const simctl = (...args) => calls.push(args.join(' '));
  const run = () => {
    const child = new EventEmitter();
    children.push(child);
    return { child };
  };
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    const start = load(simctl, run);
    start('A');
    start('B');
    children[1].emit('exit', 0);
    children[0].emit('exit', 0);
  } finally {
    console.log = log;
  }
  assert.deepEqual(calls, ['boot A', 'boot B']);
  assert.deepEqual(
    lines.map((l) => l.replace(/\d+ s$/, 'N s')),
    ['  boot B: N s', '  boot A: N s'],
  );
});

const pickBody = (re) => source.match(re)[0];

test('the harness total grows with every maestro() run', async () => {
  const maestroSource = pickBody(/async function maestro\(serial[\s\S]*?\n}\n/);
  const addSource = pickBody(/function addHarness[\s\S]*?\n}\n/);
  const clock = [0, 100, 200, 400];
  const make = new Function(
    'path',
    'run',
    'finish',
    'logCommandTimes',
    'Date',
    `let harnessMs = 0; let maestroRuns = 0; const maestroLines = [];
const debugOutput = 'd'; const root = 'r'; const ios = true; const VOTE = 1; const VOTE_IOS = 2;
${addSource}
${maestroSource}
return { maestro, total: () => harnessMs };`,
  );
  const times = [...clock];
  const fakeDate = { now: () => times.shift() };
  const { maestro, total } = make(
    { join: (...parts) => parts.join('/') },
    () => ({ lines: [] }),
    async () => true,
    () => 50,
    fakeDate,
  );
  await maestro('A', 'see');
  assert.equal(total(), 50);
  await maestro('A', 'vote');
  assert.equal(total(), 50 + 150);
});

test('the developer-path line is asked for with the walk platform, so Android prints none', () => {
  assert.match(source, /developerLine\(ios, total, harnessMs\)/);
});
