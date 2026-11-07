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
runtime.start().catch((err: unknown) => {
  // A failed start (port in use, handoff file not writable) must say why
  // instead of surfacing as an unhandled rejection or a silent hang; the
  // runtime is closed so the worklet does not keep a half-started server.
  console.error(
    `[runtime] failed to start: ${err instanceof Error ? err.message : String(err)}`,
  );
  runtime.close();
});
