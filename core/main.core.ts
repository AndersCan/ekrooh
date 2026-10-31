import { createWorkletRuntime, resolveWorkletConfig } from './runtime';

/**
 * Reference Bare worklet entry. On-device hosts pass the configuration via
 * `Worklet.Configuration.assets` arguments (`["<webAssets>", "<storage>",
 * "<cache>"]`), landing at `Bare.argv[0..2]`. Under the Bare CLI,
 * `scripts/dev-bare.mjs` passes `mode=dev` (auth off, fixed port, no handoff
 * file) and the Vite dev origins; without `mode=dev` the runtime keeps the
 * secure device defaults. Consumers building their own worklet entry use
 * `createWorkletRuntime` from `@ekrooh/bare/runtime` — this file exists to keep
 * the framework's own reference running.
 */
const runtime = createWorkletRuntime(resolveWorkletConfig());
void runtime.start();
