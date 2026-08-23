import { createWorkletRuntime, resolveWorkletConfig } from './runtime';

// The Bare worklet runtime provides no Web Crypto global. Core message code
// (core/messages/host-ipc.ts, core/messages/rpc-messenger.ts) relies on
// `globalThis.crypto.getRandomValues` for unguessable correlation ids; Node
// and browsers supply it, so install it here from the native bare-crypto
// module. The worklet build (build:bare:app → esbuild --packages=external)
// keeps bare-crypto external, so it resolves natively in the worklet and is
// never pulled into the browser bundle. Consumers with their own worklet entry
// should mirror this guard.
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

/**
 * Reference Bare worklet entry. On-device hosts pass the configuration via
 * `Worklet.Configuration.assets` arguments (`["<webAssets>", "<storage>",
 * "<cache>"]`), landing at `Bare.argv[0..2]`; the Bare CLI (dev) passes the
 * binary and script path instead, which resolves to dev mode (auth off, fixed
 * port, no handoff file). Consumers building their own worklet entry use
 * `createWorkletRuntime` from `@ekrooh/bare/runtime` — this file exists to keep
 * the framework's own reference running.
 */
const runtime = createWorkletRuntime(resolveWorkletConfig());
void runtime.start();
