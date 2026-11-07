import { describe, expect, it } from 'vite-plus/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pins the archive checks in fetch-prebuilds.mjs (G-9). The script is plain
// JS; a non-literal dynamic import keeps tsc from asking for declarations.
const modUrl = new URL('./fetch-prebuilds.mjs', import.meta.url).href;
const mod = await import(modUrl);

describe('fetch-prebuilds archive checks', () => {
  it('fails closed on a placeholder, missing or wrong SHA-256', () => {
    const real = 'a'.repeat(64);
    expect(() => mod.verifySha256('x', undefined, real)).toThrow(
      /no real SHA-256/,
    );
    expect(() => mod.verifySha256('x', 'TODO', real)).toThrow(
      /no real SHA-256/,
    );
    expect(() => mod.verifySha256('x', 'b'.repeat(64), real)).toThrow(/FAILED/);
    expect(() => mod.verifySha256('x', real.toUpperCase(), real)).not.toThrow();
  });

  it('refuses entries that escape the target dir', () => {
    expect(() =>
      mod.checkEntryNames(['android/bare-kit/classes.jar']),
    ).not.toThrow();
    for (const bad of [
      '../evil',
      'android/../../evil',
      '/etc/passwd',
      'android\\..\\evil',
      'C:/evil',
    ]) {
      expect(() => mod.checkEntryNames(['ios/ok', bad]), bad).toThrow(
        /outside/,
      );
    }
  });

  it('spots symlink entries in a zipinfo listing', () => {
    const listing = [
      'Archive:  prebuilds.zip',
      '-rw-r--r--  3.0 unx     1234 bx defN 25-Jan-01 00:00 android/bare-kit/classes.jar',
      'lrwxrwxrwx  3.0 unx       12 bx stor 25-Jan-01 00:00 ios/link to dir',
      'drwxr-xr-x  3.0 unx        0 bx stor 25-Jan-01 00:00 ios/',
      '3 files, 1246 bytes uncompressed',
    ].join('\n');
    expect(mod.symlinkEntries(listing)).toEqual(['ios/link to dir']);
  });

  it('finds symlinks on disk after extraction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'ios/sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'ios/sub/file'), 'x');
      expect(mod.findSymlinks(dir)).toEqual([]);
      fs.symlinkSync('/etc', path.join(dir, 'ios/sub/escape'));
      expect(mod.findSymlinks(dir)).toEqual([
        path.join('ios', 'sub', 'escape'),
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the destination dirs it replaces from the lockfile patterns', () => {
    const lock = JSON.parse(
      fs.readFileSync(
        new URL('./prebuilds.lock.json', import.meta.url),
        'utf8',
      ),
    );
    const patterns = lock.artifacts['prebuilds.zip'].extract;
    expect(mod.extractRoots(patterns)).toEqual(['android', 'ios']);
    expect(() => mod.extractRoots(['*/x'])).toThrow(/Bad extract/);
    expect(() => mod.extractRoots(['../x'])).toThrow(/Bad extract/);
  });
});
