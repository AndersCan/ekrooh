#!/usr/bin/env node
/**
 * Docs gates, mirroring mantaq's `scripts/docs-check.mjs`.
 *
 * Gate A — Internal links. Every `slug:` in astro.config.mjs and every
 *          relative markdown link in a docs page resolves to a real content
 *          file.
 * Gate B — API truth. Every `@ekrooh/bare/*` import in a docs page resolves
 *          to a real subpath export AND a real named export of the built
 *          package (dist/ — run `npm run build:pkg` first, as `vp check`
 *          requires).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS_DIR = join(ROOT, 'apps/docs/src/content/docs');
const ASTRO_CONFIG = join(ROOT, 'apps/docs/astro.config.mjs');

const pkg = require(join(ROOT, 'package.json'));

let failures = 0;

function fail(message) {
  failures++;
  console.error(`  ✗ ${message}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else if (entry.endsWith('.mdx')) out.push(full);
  }
  return out;
}

function read(file) {
  return readFileSync(file, 'utf8');
}

function extractSlugs(configSource) {
  const slugs = new Set();
  for (const m of configSource.matchAll(/slug:\s*["']([^"']+)["']/g)) {
    slugs.add(m[1]);
  }
  return slugs;
}

console.log('docs:check');
console.log('');

// ── Gate A: internal links ────────────────────────────────────────────────
console.log('Gate A — internal links');

const pages = walkFiles(DOCS_DIR);
const pagesBySlug = new Set(
  pages.map((p) => relative(DOCS_DIR, p).replace(/\.mdx$/, '')),
);

let checked = 0;
for (const slug of extractSlugs(read(ASTRO_CONFIG))) {
  checked++;
  if (!pagesBySlug.has(slug)) {
    fail(`astro.config.mjs — sidebar slug has no page: ${slug}`);
  }
}
for (const page of pages) {
  const source = read(page);
  for (const m of source.matchAll(/\]\(([^)]+\.mdx|[^)]+\.md)\)/g)) {
    const target = m[1];
    const resolved = join(dirname(page), target);
    const exists = statSafe(resolved);
    if (!exists) fail(`${relative(ROOT, page)} — broken link: ${target}`);
  }
}
if (checked === 0) fail('no sidebar slugs found in astro.config.mjs');

function statSafe(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// ── Gate B: API truth ─────────────────────────────────────────────────────
console.log('Gate B — API truth');

const exportsMap = pkg.exports;
if (typeof exportsMap !== 'object' || exportsMap === null) {
  fail('package.json has no exports map');
  process.exit(failures > 0 ? 1 : 0);
}

/** Resolve a subpath's built type declaration (.d.mts) from the exports map. */
function declFileFor(subpath) {
  const value = exportsMap[subpath];
  if (typeof value !== 'string' || !value.startsWith('./dist/')) return null;
  const withExt = value.replace(/\.mjs$/, '.d.mts');
  if (statSafe(join(ROOT, withExt))) return withExt;
  return null;
}

/** Names exported by a built .d.mts file (parses the final `export {...}`). */
function extractDeclExports(file) {
  const source = read(file);
  const names = new Set();
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const raw of m[1].split(',')) {
      let name = raw.trim().replace(/^type\s+/, '');
      name = name.split(' as ')[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

const importRe =
  /import\s+(?:type\s*)?(?:\{([^}]+)\}|\* as \w+)(?:\s*,\s*\{([^}]+)\})?\s*from\s*["'](@ekrooh\/bare[^"']+)["']/g;

let importCount = 0;
for (const page of pages) {
  const source = read(page);
  for (const m of source.matchAll(importRe)) {
    const specifier = m[3];
    const names = [
      ...(m[1] ? m[1].split(',') : []),
      ...(m[2] ? m[2].split(',') : []),
    ]
      .map((s) =>
        s
          .trim()
          .replace(/^type\s+/, '')
          .split(' as ')[0]
          .trim(),
      )
      .filter(Boolean);
    importCount++;

    const subpath =
      './' + specifier.replace(/^@ekrooh\/bare\/?/, '').replace(/\/$/, '');
    const target = subpath === './' ? '.' : subpath;

    const decl = declFileFor(target);
    if (!decl) {
      fail(
        `${relative(ROOT, page)} — unknown subpath ${specifier} (no "${target}" in exports map)`,
      );
      continue;
    }

    const exported = extractDeclExports(decl);
    if (exported.size === 0) {
      fail(`${relative(ROOT, page)} — cannot parse exports from ${decl}`);
      continue;
    }

    for (const name of names) {
      if (!exported.has(name)) {
        fail(`${relative(ROOT, page)} — ${specifier} does not export ${name}`);
      }
    }
  }
}

console.log('');
if (failures > 0) {
  console.error(`docs:check FAILED — ${failures} problem(s)`);
  process.exit(1);
}
console.log(
  `docs:check OK — ${pages.length} pages, ${importCount} imports checked`,
);
