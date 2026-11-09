import {
  createWorkletRuntime,
  resolveWorkletConfig,
} from "@ekrooh/bare/runtime";
import { createSync } from "@ekrooh/bare/sync";
import { createVotePlugin, parseCounts, type Counts } from "./vote-plugin";

/** Global provided by the Bare runtime (also present in bare-kit worklets). */
declare const Bare: { argv?: string[]; exit(code?: number): never } | undefined;

/**
 * On a phone the host passes the configuration in `Bare.argv[0..2]`. Under
 * `npm run dev`, scripts/dev.mjs passes `mode=dev` (auth off) plus the Vite
 * origins and `--port <n>`. Without `mode=dev` the secure device defaults apply.
 */
function devPort(): number | undefined {
  const argv =
    typeof Bare !== "undefined" && Array.isArray(Bare.argv) ? Bare.argv : [];
  const index = argv.indexOf("--port");
  return index >= 0 ? Number(argv[index + 1]) : undefined;
}

const port = devPort();
const runtime = createWorkletRuntime({
  ...resolveWorkletConfig(),
  ...(port ? { port } : {}),
});
const [syncError, sync] = createSync<Counts>({
  storage: runtime.config.storage,
  parse: parseCounts,
});
if (syncError !== null) {
  console.log(`[vote] sync failed to start: ${syncError.message}`);
  if (typeof Bare !== "undefined") Bare.exit(1);
  throw syncError;
}
runtime.pluginRegistry.register(createVotePlugin(sync));

runtime.start().then(
  ({ origin }) => {
    console.log(`[vote] backend ready on ${origin}`);
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string } | null)?.code ?? "";
    if (code.includes("EADDRINUSE") || message.includes("EADDRINUSE")) {
      console.log(
        `[vote] port ${port ?? 8080} is in use. Stop the other dev server and run npm run dev again.`,
      );
    } else {
      console.log(`[vote] backend failed to start: ${message}`);
    }
    if (typeof Bare !== "undefined") Bare.exit(1);
  },
);
