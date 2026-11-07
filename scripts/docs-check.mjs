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
 * Gate C — Snippets type-check. Every ```ts block in a docs page is written
 *          out as its own module and type-checked with `tsc` against the
 *          built package (`@ekrooh/bare/*` mapped through the exports map to
 *          `dist/*.d.mts`). This catches calls to members that do not exist
 *          (`transport.invoke`), wrong argument shapes and wrong builder
 *          paths, not only wrong import names. A snippet must therefore be
 *          self-contained: declare what it uses but does not build
 *          (`declare const transport: MessageTransport;`). A snippet that is
 *          intentionally partial (a type shape, another library's API, a
 *          fragment of a larger file) is opted out with the MDX comment
 *          `{/* docs-check: skip *\/}` on the line before the fence.
 *          Imports of relative or non-ekrooh modules that cannot be resolved
 *          are tolerated (they type as `any`); everything else is an error.
 * Gate D — Denylist. Known non-existent or retired APIs never reappear in a
 *          docs page or a readme, skipped snippets and prose included.
 *
 * Gates B and C read dist/, so run this after `npm run build:pkg`; a stale
 * dist/ gives stale answers.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

/**
 * Names exported by a built .d.mts file: `export {...}` / `export type {...}`
 * lists plus inline `export declare function X` / `export interface X` forms
 * (TypeScript 7 emits the latter instead of one trailing export list).
 */
function extractDeclExports(file) {
  const source = read(file);
  const names = new Set();
  for (const m of source.matchAll(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:function|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s+(?:type\s*)?\{([^}]+)\}/g)) {
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

// ── Gate C: snippets type-check ───────────────────────────────────────────
console.log('Gate C — ts snippets type-check');

const SKIP_MARKER = /\{\/\*\s*docs-check:\s*skip\s*\*\/\}/;
const FENCE_OPEN = /^(\s*)```ts\s*$/;

/** The ```ts blocks of a page: `{ line, code, skip }`, where `line` is the
 * 1-based page line of the first code line. Indentation (a block nested in a
 * list item) is stripped. */
function tsBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;
    const indent = open[1];
    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '```') {
      body.push(
        lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j],
      );
      j++;
    }
    let prev = i - 1;
    while (prev >= 0 && lines[prev].trim() === '') prev--;
    blocks.push({
      line: i + 2,
      code: body.join('\n'),
      skip: prev >= 0 && SKIP_MARKER.test(lines[prev]),
    });
    i = j;
  }
  return blocks;
}

const SNIPPET_DIR = join(ROOT, 'node_modules/.cache/docs-check');
// Every snippet is a module (so top-level await and per-snippet names work).
const PRELUDE = 'export {};\n';
const PRELUDE_LINES = 1;

/** `@ekrooh/bare/*` → built declarations, straight from the exports map. */
const paths = {};
let distMissing = false;
for (const key of Object.keys(exportsMap)) {
  if (key === './package.json') continue;
  const decl = declFileFor(key);
  if (!decl) {
    distMissing = true;
    continue;
  }
  const specifier =
    key === '.' ? '@ekrooh/bare' : `@ekrooh/bare/${key.slice(2)}`;
  paths[specifier] = [join(ROOT, decl)];
}

const snippets = new Map(); // snippet file -> { page, line }
let skipped = 0;
rmSync(SNIPPET_DIR, { recursive: true, force: true });
mkdirSync(SNIPPET_DIR, { recursive: true });
for (const page of pages) {
  const rel = relative(DOCS_DIR, page).replace(/\.mdx$/, '');
  tsBlocks(read(page)).forEach((block, n) => {
    if (block.skip) {
      skipped++;
      return;
    }
    const file = join(SNIPPET_DIR, `${rel.replace(/\//g, '__')}__${n + 1}.ts`);
    writeFileSync(file, PRELUDE + block.code + '\n');
    snippets.set(file, { page, line: block.line });
  });
}

if (distMissing) {
  fail('dist/ declarations missing — run `npm run build:pkg` first');
} else if (snippets.size > 0) {
  writeFileSync(
    join(SNIPPET_DIR, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: ['node'],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          isolatedModules: true,
          paths,
        },
        files: [...snippets.keys()],
      },
      null,
      2,
    ),
  );
  // The package's `bin` entry (its `exports` map hides `bin/tsc`).
  const tscBin = join(
    dirname(require.resolve('typescript/package.json')),
    require('typescript/package.json').bin.tsc,
  );
  const tsc = spawnSync(
    process.execPath,
    [tscBin, '-p', join(SNIPPET_DIR, 'tsconfig.json'), '--pretty', 'false'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (tsc.error) fail(`could not run tsc: ${tsc.error.message}`);
  const diagnostic = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  let parsed = 0;
  for (const raw of (tsc.stdout + tsc.stderr).split('\n')) {
    const m = diagnostic.exec(raw.trim());
    if (!m) continue;
    parsed++;
    const [, file, line, col, code, message] = m;
    // An unresolvable relative or third-party import types as `any`: the
    // snippet stands for a consumer file we do not have. `@ekrooh/bare` must
    // always resolve (Gate B also checks it).
    if (
      (code === 'TS2307' || code === 'TS7016') &&
      !/'@ekrooh\/bare/.test(message)
    ) {
      continue;
    }
    const where = snippets.get(join(file.startsWith('/') ? '' : ROOT, file));
    const location = where
      ? `${relative(ROOT, where.page)}:${where.line + Number(line) - 1 - PRELUDE_LINES}:${col}`
      : `${file}(${line},${col})`;
    fail(`${location} — ${code} ${message}`);
  }
  // A non-zero exit with no diagnostic we could read is a tsc failure, not
  // a clean run with tolerated imports.
  if (tsc.status !== 0 && parsed === 0) {
    fail(`tsc exited ${tsc.status}:\n${tsc.stdout}${tsc.stderr}`);
  }
}

// ── Gate D: denylist ──────────────────────────────────────────────────────
console.log('Gate D — retired / non-existent APIs');

/** APIs that do not exist (or no longer exist) but that docs have shown.
 * Extend this when a review finds another one. */
const DENYLIST = [
  [
    /\btransport\.invoke\(/,
    'MessageTransport has no invoke(); use a PluginBus (`bus.invoke`)',
  ],
  [
    /discovery(Events)?\.summary\b/,
    'core.discovery has `discovery.list`, not `summary`',
  ],
  [
    /\bmediaEvents\.(pick|capture)\(/,
    'builders are `mediaEvents.media.pick(kind)`',
  ],
  [
    /\bpermissionEvents\.(request|status)\(/,
    'builders are `permissionEvents.permissions.request(id)`',
  ],
  [
    /\bhealthEvents\.(ping|payloadEcho|roundtrip)\(/,
    'builders are `healthEvents.health.ping()`',
  ],
  [
    /\bawait createWorkletRuntime\(/,
    'createWorkletRuntime is synchronous; await `runtime.start()`',
  ],
  [/\bawait createLoopbackServer\(/, 'createLoopbackServer is synchronous'],
  [
    /\bio\.ekrooh:bare-host\b/,
    'the AAR is `io.github.anderscan.ekrooh:bare-host`',
  ],
  [
    /window\.__ekrooh\.token\b/,
    'the page gets only `window.__ekrooh.bootstrap`',
  ],
  [/\?token=/, 'there is no `?token=` auth path'],
];
// `?token=` is only allowed where a page explains that it does not exist.
const NEGATION = /\b(no|never|removed|not)\b/i;

function readmes(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    if (['build', 'dist', 'prebuilds', 'fastlane'].includes(entry.name))
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readmes(full));
    else if (/^readme\.md$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const denyTargets = [...pages, ...readmes(ROOT)];
for (const file of denyTargets) {
  read(file)
    .split('\n')
    .forEach((text, i) => {
      for (const [pattern, why] of DENYLIST) {
        if (!pattern.test(text)) continue;
        if (pattern.source.includes('token=') && NEGATION.test(text)) continue;
        fail(`${relative(ROOT, file)}:${i + 1} — ${why}`);
      }
    });
}

console.log('');
if (failures > 0) {
  console.error(`docs:check FAILED — ${failures} problem(s)`);
  process.exit(1);
}
console.log(
  `docs:check OK — ${pages.length} pages, ${importCount} imports, ${snippets.size} snippets type-checked (${skipped} skipped), ${denyTargets.length} files denylist-checked`,
);
