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

describe('fetch-prebuilds download', () => {
  const args = { repo: 'o/r', version: 'v1', assetName: 'a.zip' };
  const direct = 'https://github.com/o/r/releases/download/v1/a.zip';
  const api = 'https://api.github.com/repos/o/r/releases/tags/v1';
  const assetApi = 'https://api.github.com/repos/o/r/releases/assets/7';
  const bytes = (text: string) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  });
  const status = (code: number) => ({ ok: false, status: code });
  const run = (answers: Record<string, unknown[]>) => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      const next = answers[url]?.shift();
      if (next instanceof Error) throw next;
      return next ?? status(404);
    };
    const result = mod.downloadAsset({
      ...args,
      fetchImpl,
      sleep: async () => {},
      log: () => {},
    });
    return { calls, result };
  };

  it('retries the download URL on 5xx and network errors', async () => {
    const { calls, result } = run({
      [direct]: [status(504), new Error('fetch failed'), bytes('zip')],
    });
    expect((await result).toString()).toBe('zip');
    expect(calls).toEqual([direct, direct, direct]);
  });

  it('falls back to the API asset when the download URL keeps failing', async () => {
    const { calls, result } = run({
      [direct]: [status(504), status(504), status(504), status(504)],
      [api]: [
        bytes(JSON.stringify({ assets: [{ name: 'a.zip', url: assetApi }] })),
      ],
      [assetApi]: [bytes('zip')],
    });
    expect((await result).toString()).toBe('zip');
    expect(calls.slice(-2)).toEqual([api, assetApi]);
  });

  it('does not retry a 404 and fails when the API has no such asset', async () => {
    const { calls, result } = run({
      [direct]: [status(404)],
      [api]: [bytes(JSON.stringify({ assets: [] }))],
    });
    await expect(result).rejects.toThrow(/no asset a\.zip/);
    expect(calls).toEqual([direct, api]);
  });
});
