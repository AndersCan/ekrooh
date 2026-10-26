#!/usr/bin/env node
/**
 * Smoke test for the built macOS desktop app (`npm run build:desktop` first).
 *
 * Launches TWO host instances side by side with separate storage dirs and
 * asserts, for each:
 *   - the backend writes `handoff.json` and serves the web app,
 *   - the real webview connects and redeems the one-time bootstrap nonce
 *     (replaying it then answers 409, ADR 0003),
 *   - the storage dir holding `handoff.json` (and its session token) is
 *     user-only,
 * and that the two instances got different ports. Finally SIGKILLs both hosts
 * and asserts their backends exit too (stdin-EOF parent-death detection).
 *
 * Usage: node scripts/smoke-desktop.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = path.join(root, 'examples/desktop-app/dist/Ekrooh.app/Contents');
const host = path.join(app, 'MacOS/ekrooh');
const bare = path.join(app, 'Resources/bare');

/** How long the page gets to log in once the webview has connected. */
const redeemGraceMs = 5_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  throw new Error(msg);
};

/** Polls `fn` until it returns a truthy value. `fn` signals "not ready yet" by
 * returning falsy or throwing; use `fail` outside of it for hard failures. */
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

const lines = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return []; // pgrep / lsof exit 1 on no match
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Pids holding an established TCP connection to `port` (both ends). */
const connectedPids = (port) =>
  lines('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fp'])
    .filter((l) => l.startsWith('p'))
    .map((l) => Number(l.slice(1)));

const instances = [];
const tmp = mkdtempSync(path.join(tmpdir(), 'ekrooh-desktop-smoke-'));

function launch(name) {
  const storage = path.join(tmp, name);
  const child = spawn(host, ['--storage', storage], { stdio: 'inherit' });
  const inst = { name, storage, child, backend: 0 };
  instances.push(inst);
  return inst;
}

async function handoff(inst) {
  const h = await until(`${inst.name} handoff.json`, () =>
    JSON.parse(readFileSync(path.join(inst.storage, 'handoff.json'), 'utf8')),
  );
  // This host's own backend, so the orphan check below cannot be fooled by
  // (or blame) an unrelated `bare` from another run.
  const pids = lines('pgrep', ['-P', String(inst.child.pid), '-f', bare]);
  if (pids.length !== 1)
    fail(`${inst.name}: expected one backend, got ${pids.length}`);
  inst.backend = Number(pids[0]);
  return h;
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
    // handoff.json itself is written 0644 by the runtime; the host keeps the
    // storage dir around it user-only.
    const mode = statSync(inst.storage).mode & 0o777;
    if (mode & 0o077) fail(`${inst.name}: storage is mode ${mode.toString(8)}`);

    // Probing /login with the nonce would spend it if the page had not yet,
    // so first wait, without touching the server, for the webview's network
    // process to connect; then give the page a grace period and probe once.
    // A 409 can then only mean the page redeemed it; a 200 means it did not.
    await until(`${inst.name} webview to connect`, () =>
      connectedPids(h.port).some(
        (pid) => pid !== inst.backend && pid !== process.pid,
      ),
    );
    await sleep(redeemGraceMs);
    const res = await fetch(`${h.origin}/login`, {
      method: 'POST',
      body: h.bootstrap,
    });
    if (res.status !== 409) {
      fail(
        `${inst.name}: replaying the nonce answered ${res.status}, not 409; the page did not redeem it within ${redeemGraceMs}ms`,
      );
    }

    const page = await fetch(`${h.origin}/`);
    if (!page.ok) fail(`${inst.name}: GET / -> ${page.status}`);
    console.log(`ok: ${inst.name} serving ${h.origin}, nonce redeemed by page`);
  }

  for (const inst of instances) inst.child.kill('SIGKILL');
  await until(
    'backends to exit after host SIGKILL',
    () => instances.every((inst) => !alive(inst.backend)),
    10_000,
  );
  console.log('ok: no orphan backends after host SIGKILL');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  for (const inst of instances) {
    inst.child.kill('SIGKILL');
    if (inst.backend && alive(inst.backend))
      process.kill(inst.backend, 'SIGKILL');
  }
  rmSync(tmp, { recursive: true, force: true });
}
