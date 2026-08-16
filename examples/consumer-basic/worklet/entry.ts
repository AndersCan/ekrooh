import fs from 'bare-fs';
import {
  createLoopbackPush,
  createWorkletRuntime,
  resolveWorkletConfig,
} from '@ekrooh/bare/runtime';
import { createBasicPlugin } from './basic-plugin';

/** Global provided by the Bare runtime (also present in bare-kit worklets). */
declare const Bare: { argv?: string[] } | undefined;

/**
 * Consumer worklet entry — the replacement for the framework's
 * `core/main.core.ts`. On-device hosts pass the configuration via
 * `Worklet.Configuration.assets` arguments, landing at `Bare.argv[0..2]` and
 * resolved by `resolveWorkletConfig()`; under the bare CLI (dev) it resolves to
 * `{}` — dev mode (auth off, fixed port, no handoff file).
 *
 * Dev/test flags: `--web-assets <dir>` serves a built web app from the
 * loopback server (the real-stack e2e boots this way, matching the on-device
 * same-origin topology — see docs hosts/testing.mdx) and `--port <n>` overrides
 * the dev port. Both are dev-only; a device config never needs them.
 */
function devFlags(): { webAssets?: string; port?: number } {
  const argv =
    typeof Bare !== 'undefined' && Array.isArray(Bare.argv) ? Bare.argv : [];
  const webAssets = flag(argv, '--web-assets');
  const port = flag(argv, '--port');
  if (webAssets) {
    try {
      if (!fs.statSync(webAssets).isDirectory()) return {};
    } catch {
      return {};
    }
  }
  return {
    ...(webAssets ? { webAssets } : {}),
    ...(port ? { port: Number(port) } : {}),
  };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const runtime = createWorkletRuntime({
  ...resolveWorkletConfig(),
  ...devFlags(),
});

// Plugins that depend on the runtime's loopback socket are created and
// registered after the runtime exists (docs consumers/backend-push.mdx).
const push = createLoopbackPush(runtime.server, runtime.protocol);
runtime.pluginRegistry.register(createBasicPlugin({ push }));

void runtime.start().then(({ origin }) => {
  console.log(`[consumer-basic] worklet ready on ${origin}`);
});
