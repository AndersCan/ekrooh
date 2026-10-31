import { describe, expect, it } from 'vite-plus/test';
import fs from 'node:fs';
import path from 'node:path';

// Greppable security invariants from docs/security.md ("Mechanical checks").
// Each check reads files only; behavior is pinned by the tests next to the code.

const ROOT = path.dirname(new URL(import.meta.url).pathname);

/** Shipped TypeScript under `dirs`: no tests, no generated bundles. */
function sourceFiles(dirs: string[], exclude: string[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), {
      withFileTypes: true,
    })) {
      const rel = path.posix.join(dir, entry.name);
      if (exclude.some((e) => rel === e || rel.startsWith(`${e}/`))) continue;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(rel)) {
        out.push(rel);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

/** `file:line` for every non-comment line of `files` matching `pattern`. */
function offendingLines(files: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*')) return;
      if (pattern.test(line)) hits.push(`${file}:${i + 1}`);
    });
  }
  return hits;
}

describe('security invariants (docs/security.md)', () => {
  it('shipped web and runtime code has no HTML-injection or eval sinks', () => {
    // Script in the app origin can open the protocol socket and invoke every
    // plugin, so the page must never turn data into markup or code.
    const files = sourceFiles([
      'core',
      'plugins',
      'web',
      'examples/web',
      'examples/consumer-basic',
    ]);
    const sink =
      /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|unsafeHTML|\beval\(|new Function\(/;
    expect(offendingLines(files, sink)).toEqual([]);
  });

  it('no server sets a CORS header', () => {
    // The loopback gate is the only cross-origin policy; a CORS header would
    // let a website read gated responses or (the dev harness) credentials.
    const files = sourceFiles(['core', 'plugins']);
    expect(offendingLines(files, /Access-Control-Allow-Origin/i)).toEqual([]);
  });

  it('id- and secret-minting code never uses Math.random', () => {
    const files = sourceFiles(['core/messages', 'core/server', 'plugins']);
    expect(offendingLines(files, /Math\.random\(/)).toEqual([]);
  });

  it('core and plugins read Web Crypto only through the Platform seam', () => {
    // Bare has no Web Crypto global (ekrooh#268): randomness is injected via
    // `Platform`, and only its web default may touch `globalThis.crypto`.
    const files = sourceFiles(
      ['core', 'plugins'],
      ['core/messages/platform.ts'],
    );
    expect(offendingLines(files, /globalThis\.crypto|getRandomValues/)).toEqual(
      [],
    );
  });

  it('every workflow action is pinned to a full commit SHA', () => {
    const dir = path.join(ROOT, '.github/workflows');
    const unpinned: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /^\s*-?\s*uses:\s*['"]?([^\s'"#]+)/.exec(line);
        if (!m || m[1].startsWith('./')) return;
        if (!/@[0-9a-f]{40}$/.test(m[1])) unpinned.push(`${name}:${i + 1}`);
      });
    }
    expect(unpinned).toEqual([]);
  });

  it('no workflow runs untrusted PR code with secrets (pull_request_target)', () => {
    const dir = path.join(ROOT, '.github/workflows');
    const offenders = fs.readdirSync(dir).filter((name) =>
      fs
        .readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .some(
          (line) =>
            !line.trim().startsWith('#') &&
            /\bpull_request_target\b/.test(line),
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('the release job runs no dependency install scripts', () => {
    // It holds the npm OIDC token and signing secrets.
    const release = fs.readFileSync(
      path.join(ROOT, '.github/workflows/release.yml'),
      'utf8',
    );
    const installs = release
      .split('\n')
      .filter((line) => /\bnpm (ci|install|i)\b/.test(line));
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) expect(line).toContain('--ignore-scripts');
  });

  it('the Bare Kit prebuild lockfile pins a real SHA-256', () => {
    const lock = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts/prebuilds.lock.json'), 'utf8'),
    ) as { artifacts: Record<string, { sha256: string }> };
    const artifacts = Object.entries(lock.artifacts);
    expect(artifacts.length).toBeGreaterThan(0);
    for (const [name, { sha256 }] of artifacts) {
      expect(sha256, name).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('Package.swift resolves the BareKit binary the lockfile pins', () => {
    // One fixed url + checksum form on main and every tag: no release-time
    // switch to forget (RELEASING.md, "Bumping Bare Kit").
    const lock = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts/prebuilds.lock.json'), 'utf8'),
    ) as { spm: Record<string, { url: string; sha256: string }> };
    const pin = lock.spm['BareKit.xcframework.zip'];
    const manifest = fs.readFileSync(path.join(ROOT, 'Package.swift'), 'utf8');
    expect(manifest).toContain(`url: "${pin.url}"`);
    expect(manifest).toContain(`checksum: "${pin.sha256}"`);
    expect(manifest).not.toMatch(/binaryTarget\([^)]*\bpath:/s);
  });

  it('the reference FileProvider exposes only the captures directory', () => {
    const xml = fs.readFileSync(
      path.join(ROOT, 'examples/android-app/src/main/res/xml/file_paths.xml'),
      'utf8',
    );
    const paths = [...xml.matchAll(/<([a-z-]+-path)\b[^>]*\bpath="([^"]*)"/g)];
    expect(paths.map(([, kind, p]) => `${kind}:${p}`)).toEqual([
      'cache-path:captures/',
    ]);
  });
});
