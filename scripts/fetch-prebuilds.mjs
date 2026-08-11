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
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2] ?? 'v2.3.0';
const archive = path.join(root, 'prebuilds.zip');

mkdirSync(path.join(root, 'prebuilds'), { recursive: true });

console.log(`Fetching bare-kit ${version} release artifacts...`);
execFileSync(
  'gh',
  ['release', 'download', '--repo', 'holepunchto/bare-kit', version],
  { cwd: root, stdio: 'inherit' },
);

console.log('Unpacking android/* and ios/* into prebuilds/ ...');
execFileSync(
  'unzip',
  ['-o', archive, 'android/*', 'ios/*', '-d', 'prebuilds/'],
  { cwd: root, stdio: 'inherit' },
);

// Best-effort cleanup of the downloaded archive.
rmSync(archive, { force: true });

console.log(
  `Done. Prebuilds ready under prebuilds/android/bare-kit and ` +
    `prebuilds/ios/BareKit.xcframework (${version}).`,
);
