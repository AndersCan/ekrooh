#!/usr/bin/env node
/**
 * Smoke test for the built desktop app (macOS .app or Linux tarball dir) (`npm run build:desktop` first).
 *
 * Launches TWO host instances side by side with separate storage dirs and
 * asserts, for each:
 *   - the backend hands off over its pipe and serves the web app, on its own
 *     port,
 *   - the real webview connects and redeems the one-time bootstrap nonce
 *     (replaying it then answers 409, ADR 0003),
 *   - the storage dir is user-only and holds no `handoff.json` (the session
 *     token never touches disk).
 * Then:
 *   - a second launch on a storage dir already in use is a no-op (exit 0,
 *     no second backend),
 *   - a host whose backend dies keeps its window (error page) instead of
 *     vanishing,
 *   - SIGKILLing a host takes its backend down too (stdin-EOF parent-death
 *     detection).
 *
 * The hosts copy the handoff they receive to a file through the
 * `EKROOH_TEST_HANDOFF_COPY` test hook; nothing else exposes the nonce.
 *
 * Usage: node scripts/smoke-desktop.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'examples/desktop-app/dist');
const layout =
  process.platform === 'darwin'
    ? { dir: 'Ekrooh.app/Contents', host: 'MacOS', res: 'Resources' }
    : {
        dir: `ekrooh-linux-${process.arch}`,
        host: 'bin',
        res: 'resources',
      };
const host = path.join(dist, layout.dir, layout.host, 'ekrooh');
const bare = path.join(dist, layout.dir, layout.res, 'bare');

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

const backendsOf = (hostPid) =>
  lines('pgrep', ['-P', String(hostPid), '-f', bare]).map(Number);

/** Pids holding an established TCP connection to `port` (both ends). */
const connectedPids = (port) =>
  lines('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fp'])
    .filter((l) => l.startsWith('p'))
    .map((l) => Number(l.slice(1)));

const instances = [];
const tmp = mkdtempSync(path.join(tmpdir(), 'ekrooh-desktop-smoke-'));

function launch(name, storage = path.join(tmp, name)) {
  const handoffCopy = path.join(tmp, `${name}.handoff.json`);
  const child = spawn(host, ['--storage', storage], {
    stdio: 'inherit',
    env: { ...process.env, EKROOH_TEST_HANDOFF_COPY: handoffCopy },
  });
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  const inst = { name, storage, handoffCopy, child, exited, backend: 0 };
  instances.push(inst);
  return inst;
}

async function handoff(inst) {
  const h = await until(`${inst.name} handoff`, () =>
    JSON.parse(readFileSync(inst.handoffCopy, 'utf8')),
  );
  const pids = backendsOf(inst.child.pid);
  if (pids.length !== 1) {
    fail(`${inst.name}: expected one backend, got ${pids.length}`);
  }
  inst.backend = pids[0];
  return h;
}

try {
  const a = launch('a');
  const b = launch('b');
  const [ha, hb] = [await handoff(a), await handoff(b)];

  if (ha.origin === hb.origin) fail(`both instances bound ${ha.origin}`);

  for (const [inst, h] of [
    [a, ha],
    [b, hb],
  ]) {
    const mode = statSync(inst.storage).mode & 0o777;
    if (mode & 0o077) fail(`${inst.name}: storage is mode ${mode.toString(8)}`);
    if (existsSync(path.join(inst.storage, 'handoff.json'))) {
      fail(`${inst.name}: handoff.json written to disk`);
    }

    // Probing /login with the nonce would spend it if the page had not yet,
    // so first wait, without touching the server, for the webview's network
    // process to connect; then give the page a grace period and probe once.
    // A 409 can then only mean the page redeemed it; a 200 means it did not.
    const port = Number(new URL(h.origin).port);
    await until(`${inst.name} webview to connect`, () =>
      connectedPids(port).some(
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

  const dup = launch('a-again', a.storage);
  const dupExit = await Promise.race([dup.exited, sleep(10_000)]);
  if (!dupExit) fail('second launch on a busy storage dir did not exit');
  if (dupExit.code !== 0) fail(`second launch exited ${dupExit.code}, not 0`);
  if (backendsOf(a.child.pid).length !== 1) fail('a lost its backend');
  console.log('ok: second launch on the same storage is a no-op');

  process.kill(b.backend, 'SIGKILL');
  await sleep(2_000);
  if (!alive(b.child.pid)) fail('b: host exited when its backend died');
  console.log('ok: host survives its backend dying (error page)');

  for (const inst of instances) inst.child.kill('SIGKILL');
  await until(
    'backends to exit after host SIGKILL',
    () => instances.every((inst) => !inst.backend || !alive(inst.backend)),
    10_000,
  );
  console.log('ok: no orphan backends after host SIGKILL');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  for (const inst of instances) {
    const log = path.join(inst.storage, 'backend.log');
    if (existsSync(log)) {
      console.error(
        `--- ${inst.name} backend.log ---\n${readFileSync(log, 'utf8')}`,
      );
    }
  }
  process.exitCode = 1;
} finally {
  for (const inst of instances) {
    inst.child.kill('SIGKILL');
    if (inst.backend && alive(inst.backend))
      process.kill(inst.backend, 'SIGKILL');
  }
  rmSync(tmp, { recursive: true, force: true });
}
