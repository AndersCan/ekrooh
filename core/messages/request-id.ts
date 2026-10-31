import type { Platform } from './platform';

/**
 * CSPRNG-backed correlation id for RPC requests.
 *
 * Shared by the RPC messenger (`rpc-messenger.ts`) and the host IPC bridge
 * (`host-ipc.ts`) so the unguessable, collision-resistant guarantee can never
 * regress in a single copy. Request
 * IDs must never be derived from `Math.random()` — a guessable id lets a peer
 * spoof or collide with an in-flight request and corrupt correlation. See
 * ekrooh#141. The random source is injected, never read from a global
 * (ekrooh#268).
 */
export function createRequestId(
  platform: Pick<Platform, 'randomBytes' | 'now'>,
): string {
  const bytes = platform.randomBytes(new Uint8Array(16));
  const rand = bytes.reduce((acc, b) => acc + b.toString(36), '').slice(0, 22);
  return `${platform.now().toString(36)}-${rand}`;
}
