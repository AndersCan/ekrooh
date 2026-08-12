import fs from 'bare-fs';
import { createHarnessSupervisor } from './harness/supervisor';

/** Global provided by the Bare runtime. */
declare const Bare: { argv?: string[] } | undefined;

/**
 * Dev/test entry for the multi-instance harness (ticket #21). Launched under
 * `bare` with `<webAssets> <baseDir>` arguments: hosts N worklet instances
 * behind a management server (`POST /instances` etc.) so Playwright can run
 * multi-user journeys one tab per instance. Dev tooling — not public surface.
 */
function resolveConfig(): { webAssets: string; baseDir: string } {
  const argv =
    typeof Bare !== 'undefined' && Array.isArray(Bare.argv) ? Bare.argv : [];
  const webAssets = argv[0];
  const baseDir = argv[1];
  if (typeof webAssets === 'string' && typeof baseDir === 'string') {
    try {
      if (fs.statSync(webAssets).isDirectory()) {
        fs.mkdirSync(baseDir, { recursive: true });
        return { webAssets, baseDir };
      }
    } catch {
      // Not a harness configuration.
    }
  }
  throw new Error(
    'harness config expected: <webAssets> <baseDir> (e.g. bare harness.core.gen.js ./examples/web/dist ./.harness-instances)',
  );
}

const config = resolveConfig();
const supervisor = createHarnessSupervisor(config);
void supervisor.origin().then((origin) => {
  console.log(`[harness] supervisor on ${origin}`);
});
