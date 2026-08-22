#!/usr/bin/env node
/**
 * Fetch Bare Kit prebuilds for the Android and iOS hosts into `prebuilds/`
 * (gitignored).
 *
 * Usage:
 *   node scripts/fetch-prebuilds.mjs            # pinned version (see below)
 *   node scripts/fetch-prebuilds.mjs v2.3.0     # explicit version
 *
 * Requires the GitHub CLI (`gh`) with access to holepunchto/bare-kit releases.
 *
 * Supply-chain integrity (issue #55): every fetched artifact's SHA-256 is
 * checked against `scripts/prebuilds.lock.json` before it is unpacked. The
 * lockfile records the pinned `version` and the expected checksum of the
 * `prebuilds.zip` release asset (the archive that contains `android/*` and
 * `ios/*`). A checksum mismatch fails the script closed — nothing is
 * extracted. When a lockfile entry is still a `TODO:` placeholder (no real
 * hash populated yet), verification is skipped but a loud warning is printed;
 * the placeholder MUST be replaced with the real SHA-256 before relying on
 * the downloaded prebuilds in any trusted context.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const version = process.argv[2] ?? 'v2.3.0';
const archive = path.join(root, 'prebuilds.zip');
const assetName = 'prebuilds.zip';
const lockPath = path.join(scriptDir, 'prebuilds.lock.json');

mkdirSync(path.join(root, 'prebuilds'), { recursive: true });

// Load and validate the integrity lockfile.
let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, 'utf8'));
} catch (err) {
  console.error(`prebuilds.lock.json missing or unreadable: ${err.message}`);
  process.exit(1);
}
if (lock.version !== version) {
  console.error(
    `Lockfile version mismatch: lockfile has ${lock.version}, ` +
      `fetch requested ${version}. Update scripts/prebuilds.lock.json when ` +
      `bumping the bare-kit version.`,
  );
  process.exit(1);
}

console.log(`Fetching bare-kit ${version} release artifact ${assetName}...`);
execFileSync(
  'gh',
  [
    'release',
    'download',
    '--repo',
    'holepunchto/bare-kit',
    version,
    '--pattern',
    assetName,
  ],
  { cwd: root, stdio: 'inherit' },
);

if (!existsSync(archive)) {
  console.error(`Expected asset ${assetName} was not downloaded.`);
  process.exit(1);
}

// Verify integrity before unpacking (fail closed on mismatch).
const expected = lock.artifacts?.[assetName]?.sha256;
const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (expected && /^[0-9a-f]{64}$/i.test(expected)) {
  if (expected.toLowerCase() !== actual) {
    rmSync(archive, { force: true });
    console.error(
      `Checksum verification FAILED for ${assetName} (${version}).\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual}\n` +
        `The downloaded prebuild was discarded. Do not bypass this check — ` +
        `investigate whether the release was tampered with or the lockfile is ` +
        `stale.`,
    );
    process.exit(1);
  }
  console.log(`Verified SHA-256 of ${assetName}: ${actual}`);
} else {
  console.warn(
    `WARNING: ${assetName} has no real SHA-256 in prebuilds.lock.json ` +
      `(${expected ?? 'missing'}). Checksum verification was SKIPPED. ` +
      `Populate the real SHA-256 before trusting these prebuilds.`,
  );
}

console.log('Unpacking android/* and ios/* into prebuilds/ ...');
execFileSync(
  'unzip',
  ['-o', archive, 'android/*', 'ios/*', '-d', 'prebuilds/'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);

// Best-effort cleanup of the downloaded archive.
rmSync(archive, { force: true });

console.log(
  `Done. Prebuilds ready under prebuilds/android/bare-kit and ` +
    `prebuilds/ios/BareKit.xcframework (${version}).`,
);
