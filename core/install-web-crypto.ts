// The Bare worklet runtime provides no Web Crypto global. Core message code
// (core/messages/host-ipc.ts, core/messages/rpc-messenger.ts) relies on
// `globalThis.crypto.getRandomValues` for unguessable correlation ids; Node
// and browsers supply it, so install it here from the native bare-crypto
// module. Worklet builds (esbuild --packages=external) keep bare-crypto
// external, so it resolves natively in the worklet and is never pulled into
// the browser bundle. Side-effect module: import it first from a worklet
// entry. Consumers with their own worklet entry should mirror this guard.
import crypto from 'bare-crypto';

function hasWebCrypto(): boolean {
  return (
    typeof (globalThis as { crypto?: Crypto }).crypto?.getRandomValues ===
    'function'
  );
}

if (!hasWebCrypto()) {
  (globalThis as { crypto?: unknown }).crypto = {
    getRandomValues(array: Uint8Array): Uint8Array {
      const bytes = crypto.randomBytes(array.byteLength);
      array.set(bytes as unknown as Uint8Array);
      return array;
    },
  } as unknown as Crypto;
}
