import fs from 'bare-fs';
import { createHarnessSupervisor } from './harness/supervisor';

/** Global provided by the Bare runtime. */
declare const Bare: { argv?: string[] } | undefined;

/**
 * Dev/test entry for the multi-instance harness (ticket #21). Launched under
 * `bare` with `<webAssets> <baseDir> [port]` arguments: hosts N worklet
 * instances behind a management server (`POST /instances` etc.) so Playwright
 * can run multi-user journeys one tab per instance. `port` pins the
 * management server for Playwright's readiness poll (default `0` = ephemeral).
 * Dev tooling — not public surface.
 */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveConfig(): { webAssets: string; baseDir: string; port: number } {
  const argv =
    typeof Bare !== 'undefined' && Array.isArray(Bare.argv) ? Bare.argv : [];
  // The bare CLI prepends [binary, script] to the app arguments, while a
  // bare-kit worklet argv starts at the app arguments directly — so locate
  // webAssets as the first argument that is an existing directory.
  const webAssetsIndex = argv.findIndex((a) => isDirectory(a));
  if (webAssetsIndex >= 0) {
    const webAssets = argv[webAssetsIndex];
    const baseDir = argv[webAssetsIndex + 1];
    const portArg = argv[webAssetsIndex + 2];
    if (typeof baseDir === 'string') {
      fs.mkdirSync(baseDir, { recursive: true });
      const port =
        typeof portArg === 'string' && portArg !== '' ? Number(portArg) : 0;
      return {
        webAssets,
        baseDir,
        port: Number.isFinite(port) && port >= 0 && port <= 65535 ? port : 0,
      };
    }
  }
  throw new Error(
    'harness config expected: <webAssets> <baseDir> [port] (e.g. bare harness.core.gen.js examples/android-app/src/main/assets ./.harness-instances 8081)',
  );
}

const config = resolveConfig();
const supervisor = createHarnessSupervisor(config);
void supervisor.origin().then((origin) => {
  console.log(`[harness] supervisor on ${origin}`);
});
