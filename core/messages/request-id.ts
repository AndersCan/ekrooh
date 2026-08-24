/**
 * CSPRNG-backed correlation id for RPC requests.
 *
 * Shared by the production messenger (`rpc-messenger.ts`) and the mantaq
 * prototype (`rpc-messenger.mantaq.ts`) so the unguessable,
 * collision-resistant guarantee can never regress in a single copy. Request
 * IDs must never be derived from `Math.random()` — a guessable id lets a peer
 * spoof or collide with an in-flight request and corrupt correlation. See
 * ekrooh#141.
 */
export function createRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const rand = bytes.reduce((acc, b) => acc + b.toString(36), '').slice(0, 22);
  return `${Date.now().toString(36)}-${rand}`;
}
