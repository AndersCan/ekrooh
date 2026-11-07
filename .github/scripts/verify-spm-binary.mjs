#!/usr/bin/env node
/**
 * Check that the SwiftPM binary (`spm` in scripts/prebuilds.lock.json, the
 * `.binaryTarget` in Package.swift) is exactly the hash-verified upstream
 * prebuild.
 *
 * The zip is built by hand when bare-kit is bumped and hosted on a GitHub
 * release. Its checksum pins bytes, not provenance, so this compares its
 * contents with `prebuilds/ios/BareKit.xcframework`, which
 * `npm run prebuilds` has just extracted from the SHA-256-checked upstream
 * archive. Run it after `npm run prebuilds`. Exits non-zero on any
 * difference.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const lock = JSON.parse(
  readFileSync(path.join(root, 'scripts/prebuilds.lock.json'), 'utf8'),
);
const pin = lock.spm['BareKit.xcframework.zip'];
const expectedDir = path.join(root, 'prebuilds/ios/BareKit.xcframework');

/** relative path → sha256 (or 'dir' / 'symlink') for every entry under dir. */
function tree(dir) {
  const out = new Map();
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const child = path.posix.join(rel, name);
      const abs = path.join(dir, child);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) out.set(child, 'symlink');
      else if (stat.isDirectory()) {
        out.set(child, 'dir');
        walk(child);
      } else {
        out.set(
          child,
          createHash('sha256').update(readFileSync(abs)).digest('hex'),
        );
      }
    }
  };
  walk('');
  return out;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ekrooh-spm-'));
try {
  const res = await fetch(pin.url);
  if (!res.ok) throw new Error(`GET ${pin.url} -> ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== pin.sha256) {
    throw new Error(`spm zip sha256 ${actual} != lockfile ${pin.sha256}`);
  }
  const zip = path.join(tmp, 'BareKit.xcframework.zip');
  writeFileSync(zip, bytes);
  const out = path.join(tmp, 'out');
  execFileSync('unzip', ['-q', zip, '-d', out], { stdio: 'inherit' });

  const want = tree(expectedDir);
  const got = tree(path.join(out, 'BareKit.xcframework'));
  const diffs = [];
  for (const [p, h] of want)
    if (got.get(p) !== h) diffs.push(`differs or missing: ${p}`);
  for (const p of got.keys())
    if (!want.has(p)) diffs.push(`extra in spm zip: ${p}`);
  if (diffs.length > 0) {
    throw new Error(
      `The SwiftPM BareKit.xcframework.zip is not the verified prebuild:\n  ` +
        diffs.join('\n  '),
    );
  }
  console.log(
    `spm zip (${pin.url}) matches the verified prebuild: ${want.size} entries.`,
  );
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
