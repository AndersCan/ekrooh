import './install-web-crypto';
import Pipe from 'bare-pipe';
import { createWorkletRuntime, resolveCliConfig } from './runtime';

declare const Bare: { argv: string[]; exit(code?: number): void };

/**
 * Desktop backend entry, spawned by the desktop host as a sidecar `bare`
 * process with labeled CLI tokens (`webassets=`, `storage=`, `cache=`,
 * `port=0`) plus `handoff=<fd>`. Auth is forced on regardless of tokens:
 *
 * - **Handoff over a pipe.** Once bound, the origin and one-time bootstrap
 *   nonce go to the host as one JSON line on the inherited `handoff` fd, which
 *   is then closed. No `handoff.json`: the session token never touches disk.
 * - **Parent-death detection.** The host keeps this process's stdin open for
 *   its whole life. When it exits or crashes the OS closes the pipe, stdin
 *   ends, and we shut down instead of leaving an orphan holding the loopback
 *   port and the storage dir.
 */

const argv = Bare.argv;
const handoffToken = argv.find((a) => a.startsWith('handoff='));
const handoffFd = Number(handoffToken?.slice('handoff='.length));
if (!Number.isInteger(handoffFd) || handoffFd < 3) {
  console.error(
    '[desktop] missing handoff=<fd>; launch through the desktop host',
  );
  Bare.exit(2);
}

// The sidecar is always a device-mode backend: whatever tokens arrive, auth
// stays on, so a host that drops `auth=on` cannot ship an open server.
const runtime = createWorkletRuntime({
  ...resolveCliConfig(argv),
  deviceMode: true,
  auth: true,
  handoffFile: false,
});

/** Graceful close, bounded so a stuck socket cannot keep a dead app alive. */
const closeTimeoutMs = 2_000;
let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => Bare.exit(code), closeTimeoutMs);
  runtime.close(() => {
    clearTimeout(timer);
    Bare.exit(code);
  });
}

try {
  // A libuv pipe read, not a parked fs-threadpool read.
  const stdin = new Pipe(0);
  stdin.on('data', () => {});
  stdin.on('end', () => shutdown(0));
  stdin.on('error', () => shutdown(0));
} catch (err) {
  // Not a pipe (e.g. run by hand from a terminal): nothing to watch.
  console.warn(
    `[desktop] stdin is not a pipe; parent-death detection off: ${err instanceof Error ? err.message : String(err)}`,
  );
}

runtime.start().then(
  ({ origin, bootstrap }) => {
    const handoff = new Pipe(handoffFd);
    handoff.on('error', (err: Error) => {
      console.error(`[desktop] handoff to the host failed: ${err.message}`);
      shutdown(1);
    });
    handoff.end(JSON.stringify({ origin, bootstrap }) + '\n');
  },
  (err: unknown) => {
    console.error(
      `[desktop] backend failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    shutdown(1);
  },
);
