#!/usr/bin/env node
/**
 * Fetch Bare Kit prebuilds for the Android and iOS hosts into `prebuilds/`
 * (gitignored).
 *
 * Usage:
 *   node scripts/fetch-prebuilds.mjs            # version pinned in the lockfile
 *   node scripts/fetch-prebuilds.mjs <version>  # must equal the lockfile version
 *
 * Needs only Node built-ins and `unzip`, and no token: the asset is fetched
 * from the public release download URL (so CI runs it with no credential).
 *
 * Supply-chain integrity (issue #55): `scripts/prebuilds.lock.json` is the
 * single source for the upstream `repo`, the pinned `version`, each release
 * asset's SHA-256 and the paths to `extract` from it. The script:
 *   1. downloads the asset into a fresh temp dir (never the repo root),
 *   2. refuses to go on without a real SHA-256, or on a mismatch,
 *   3. refuses an archive with absolute, `..` or symlink entries,
 *   4. extracts into a staging dir, re-checks it for symlinks, and only then
 *      replaces `prebuilds/<dir>` wholesale (no stale files from an older
 *      version survive).
 * Any failure exits non-zero and leaves `prebuilds/` as it was.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDir);
const lockPath = path.join(scriptDir, 'prebuilds.lock.json');

/** Throw unless `expected` is a real SHA-256 equal to `actual`. */
export function verifySha256(name, expected, actual) {
  if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
    throw new Error(
      `${name} has no real SHA-256 in prebuilds.lock.json ` +
        `(${expected ?? 'missing'}). Refusing to unpack an unverified ` +
        `prebuild.\nWhen bumping bare-kit, record this download's hash only ` +
        `after checking it against the upstream release:\n  ${actual}`,
    );
  }
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(
      `Checksum verification FAILED for ${name}.\n` +
        `  expected: ${expected}\n  actual:   ${actual}\n` +
        `Do not bypass this check: investigate whether the release was ` +
        `tampered with or the lockfile is stale.`,
    );
  }
}

/** Throw on any archive entry name that could land outside the target dir. */
export function checkEntryNames(names) {
  for (const name of names) {
    const segments = name.split('/');
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      /^[A-Za-z]:/.test(name) ||
      segments.includes('..')
    ) {
      throw new Error(`Refusing archive entry outside the target: ${name}`);
    }
  }
}

/**
 * Entry names that `zipinfo` (`unzip -Z`) lists as symlinks. A symlink entry
 * followed by a file "inside" it is how a zip writes outside its target dir.
 */
export function symlinkEntries(zipinfoListing) {
  return zipinfoListing
    .split('\n')
    .filter((line) => /^l[rwxsStT-]{9}\s/.test(line))
    .map((line) => line.trim().split(/\s+/).slice(8).join(' '));
}

/** Every symlink under `dir` (relative paths), found with lstat. */
export function findSymlinks(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(dir, rel))) {
      const child = path.join(rel, entry);
      const stat = lstatSync(path.join(dir, child));
      if (stat.isSymbolicLink()) out.push(child);
      else if (stat.isDirectory()) walk(child);
    }
  };
  walk('');
  return out;
}

/** Top-level directories named by `extract` patterns (`android/*` → android). */
export function extractRoots(patterns) {
  const roots = patterns.map((p) => p.split('/')[0]);
  for (const r of roots) {
    if (!r || r === '.' || r === '..' || r.includes('*')) {
      throw new Error(`Bad extract pattern in prebuilds.lock.json: ${r}`);
    }
  }
  return [...new Set(roots)];
}

async function main() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `prebuilds.lock.json missing or unreadable: ${err.message}`,
    );
  }
  const version = process.argv[2] ?? lock.version;
  if (lock.version !== version) {
    throw new Error(
      `Lockfile version mismatch: lockfile has ${lock.version}, fetch ` +
        `requested ${version}. Update scripts/prebuilds.lock.json when ` +
        `bumping the bare-kit version.`,
    );
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(lock.repo ?? '')) {
    throw new Error(`prebuilds.lock.json has no valid "repo": ${lock.repo}`);
  }
  if (!/^[\w.-]+$/.test(version)) {
    throw new Error(`prebuilds.lock.json has no valid "version": ${version}`);
  }

  const prebuilds = path.join(root, 'prebuilds');
  mkdirSync(prebuilds, { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ekrooh-prebuilds-'));
  try {
    for (const [assetName, entry] of Object.entries(lock.artifacts ?? {})) {
      const patterns = entry.extract ?? [];
      const roots = extractRoots(patterns);

      if (!/^[\w.-]+$/.test(assetName)) {
        throw new Error(`Bad asset name in prebuilds.lock.json: ${assetName}`);
      }
      const url = `https://github.com/${lock.repo}/releases/download/${version}/${assetName}`;
      console.log(`Fetching ${url} ...`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const archive = path.join(tmp, assetName);
      writeFileSync(archive, bytes);

      // Verify integrity before looking inside (fail closed).
      const actual = createHash('sha256').update(bytes).digest('hex');
      verifySha256(`${assetName} (${version})`, entry.sha256, actual);
      console.log(`Verified SHA-256 of ${assetName}: ${actual}`);

      const names = execFileSync('unzip', ['-Z1', archive], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
      checkEntryNames(names);
      const links = symlinkEntries(
        execFileSync('unzip', ['-Z', archive], { encoding: 'utf8' }),
      );
      if (links.length > 0) {
        throw new Error(
          `Refusing symlink entries in ${assetName}: ${links.join(', ')}`,
        );
      }

      // Staging lives inside prebuilds/ so the final rename never crosses
      // filesystems (runner temp and the workspace can be different mounts).
      const staging = mkdtempSync(path.join(prebuilds, '.staging-'));
      execFileSync('unzip', ['-q', archive, ...patterns, '-d', staging], {
        stdio: 'inherit',
      });
      const stagedLinks = findSymlinks(staging);
      if (stagedLinks.length > 0) {
        throw new Error(
          `Refusing extracted symlinks: ${stagedLinks.join(', ')}`,
        );
      }

      // Replace each destination wholesale so no stale file survives a bump.
      for (const r of roots) {
        const dest = path.join(prebuilds, r);
        rmSync(dest, { recursive: true, force: true });
        renameSync(path.join(staging, r), dest);
      }
      rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    for (const leftover of readdirSync(prebuilds)) {
      if (leftover.startsWith('.staging-')) {
        rmSync(path.join(prebuilds, leftover), {
          recursive: true,
          force: true,
        });
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(
    `Done. Prebuilds ready under prebuilds/android/bare-kit and ` +
      `prebuilds/ios/BareKit.xcframework (${version}).`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
