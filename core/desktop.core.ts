import fs from 'bare-fs';
// Side-effect import: starts the reference runtime. The desktop host passes
// the labeled CLI tokens (`webassets=`, `storage=`, `cache=`, `auth=on`,
// `port=0`), which `resolveWorkletConfig` falls through to `resolveCliConfig`.
import './main.core';

declare const Bare: { exit(code?: number): void };

/**
 * Desktop entry: the reference worklet plus parent-death detection. The host
 * keeps this process's stdin open for its whole life; when the host exits or
 * crashes the OS closes the pipe, stdin ends, and we exit instead of leaving
 * an orphaned backend holding the loopback port and the corestore lock.
 */
const buf = new Uint8Array(1024);
function watchStdin(): void {
  // Positionless read (-1) so the kernel's pipe offset is used; a stream with
  // an explicit position reports EOF immediately on a pipe.
  fs.read(0, buf, 0, buf.length, -1, (err: Error | null, n: number) => {
    if (err || n === 0) Bare.exit(0);
    else watchStdin();
  });
}
watchStdin();
