#!/usr/bin/env node
/**
 * Smoke test for the built macOS desktop app (`npm run build:desktop` first).
 *
 * Launches TWO host instances side by side with separate storage dirs and
 * asserts, for each:
 *   - the backend writes `handoff.json` and serves the web app,
 *   - the real webview loads the page and redeems the one-time bootstrap nonce
 *     (replaying it then answers 409, ADR 0003),
 * and that the two instances got different ports. Finally SIGKILLs both hosts
 * and asserts no backend is left behind (stdin-EOF parent-death detection).
 *
 * Usage: node scripts/smoke-desktop.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = path.join(root, 'examples/desktop-app/dist/Ekrooh.app/Contents');
const host = path.join(app, 'MacOS/ekrooh');
const backendMarker = path.join(app, 'Resources/bare');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  throw new Error(msg);
};

async function until(label, fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

const backendsRunning = () => {
  try {
    return execFileSync('pgrep', ['-f', backendMarker], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0; // pgrep exits 1 on no match
  }
};

const instances = [];
const tmp = mkdtempSync(path.join(tmpdir(), 'ekrooh-desktop-smoke-'));

function launch(name) {
  const storage = path.join(tmp, name);
  const child = spawn(host, ['--storage', storage], { stdio: 'inherit' });
  instances.push(child);
  return { name, storage, child };
}

async function handoff(inst) {
  return until(`${inst.name} handoff.json`, () =>
    JSON.parse(readFileSync(path.join(inst.storage, 'handoff.json'), 'utf8')),
  );
}

try {
  const a = launch('a');
  const b = launch('b');
  const [ha, hb] = [await handoff(a), await handoff(b)];

  if (ha.port === hb.port) fail(`both instances bound port ${ha.port}`);

  for (const [inst, h] of [
    [a, ha],
    [b, hb],
  ]) {
    const page = await fetch(`${h.origin}/`);
    if (!page.ok) fail(`${inst.name}: GET / -> ${page.status}`);

    // The webview injects the nonce and the page POSTs /login. Replaying the
    // spent nonce answering 409 proves a real page redeemed it.
    await until(`${inst.name} webview to redeem the nonce`, async () => {
      const res = await fetch(`${h.origin}/login`, {
        method: 'POST',
        body: h.bootstrap,
      });
      if (res.status === 200) fail(`${inst.name}: nonce was still unredeemed`);
      return res.status === 409;
    });
    console.log(`ok: ${inst.name} serving ${h.origin}, nonce redeemed by page`);
  }

  if (backendsRunning() < 2) fail('expected two running backends');

  for (const child of instances) child.kill('SIGKILL');
  await until(
    'backends to exit after host SIGKILL',
    () => {
      return backendsRunning() === 0;
    },
    10_000,
  );
  console.log('ok: no orphan backends after host SIGKILL');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  for (const child of instances) child.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
}
