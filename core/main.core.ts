import { createWorkletRuntime, resolveWorkletConfig } from './runtime';

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
