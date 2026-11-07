#!/usr/bin/env node
/**
 * Type-level public API snapshot of `@ekrooh/bare` (the JS exported surface in
 * `vision.md`'s stability contract).
 *
 * `contract.test.ts` freezes the exported value names; this freezes the types
 * and signatures: the built declaration files (`dist/*.d.mts`, emitted by
 * `vp pack`) are normalized and compared against the committed
 * `api/public-api.d.mts.snap`. Any change to a public type, signature, or a
 * type it references fails the contract test until the snapshot is
 * regenerated and the diff is reviewed as a stability-boundary change.
 *
 * Normalization keeps the snapshot about the surface, not the build:
 * - comments are dropped (JSDoc edits are not API changes);
 * - chunk hashes are dropped (`index-Do-kTNXw.d.mts` -> `index-<chunk>.d.mts`);
 * - the bundler's minified cross-chunk aliases (`import { $ as PluginManifest }`
 *   / `export { PluginManifest as $ }`) are replaced by the plain names, sorted;
 * - indentation and blank lines are dropped.
 *
 * Usage (from the repo root, after building the package):
 *   npm run build:pkg && node scripts/api-snapshot.mjs --update   # regenerate
 *   node scripts/api-snapshot.mjs --check                         # diff only
 *   node scripts/api-snapshot.mjs --dist <dir> [--out <file>]     # other build
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SNAPSHOT_PATH = path.join(ROOT, 'api', 'public-api.d.mts.snap');
export const UPDATE_COMMAND =
  'npm run build:pkg && node scripts/api-snapshot.mjs --update';

/** Drops `//` and `/* *\/` comments, leaving string and template literals
 * (string literal types such as `'core.health'`) untouched. */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && source[j] !== c) {
        if (source[j] === '\\') j++;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Basenames (no extension) of the `exports` entry files: everything else in
 * `dist/` is a shared chunk whose name carries a content hash. */
const ENTRY_NAMES = new Set(
  Object.values(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      .exports,
  )
    .filter((v) => typeof v === 'string' && v.startsWith('./dist/'))
    .map((v) => path.basename(v).replace(/\.mjs$/, '')),
);

/** `index-Do-kTNXw.d.mts` / `./index-Do-kTNXw.mjs` -> `index-<chunk>...`. */
function normalizeChunkName(name) {
  const m = /^(.*\/)?([^/]+?)(\.d\.mts|\.mjs)$/.exec(name);
  if (!m || ENTRY_NAMES.has(m[2])) return name;
  return `${m[1] ?? ''}${m[2].replace(/-[A-Za-z0-9_-]{8}$/, '-<chunk>')}${m[3]}`;
}

function sortedNames(list, pick) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(pick)
    .sort()
    .join(', ');
}

/** One normalized declaration file. */
export function normalizeDeclaration(source) {
  let text = stripComments(source);
  // `import { $ as PluginManifest, ... } from "./chunk-HASH.mjs"`
  text = text.replace(
    /import\s*(type\s*)?\{([^}]*)\}\s*from\s*(["'])(\.\/[^"']+)\3;?/g,
    (_m, type, names, _q, from) =>
      `import ${type ?? ''}{ ${sortedNames(names, (s) => {
        const m = /^(type\s+)?(\S+)\s+as\s+(\S+)$/.exec(s);
        return m ? `${m[1] ?? ''}${m[3]}` : s;
      })} } from "${normalizeChunkName(from)}";`,
  );
  // `export { PluginManifest as $, ... };` in a shared chunk (minified aliases
  // only; a real rename such as `export { a as b }` with a readable target
  // name is kept).
  text = text.replace(
    /export\s*(type\s*)?\{([^}]*)\};?/g,
    (_m, type, names) =>
      `export ${type ?? ''}{ ${sortedNames(names, (s) => {
        const m = /^(type\s+)?(\S+)\s+as\s+(\S+)$/.exec(s);
        if (m && /^[A-Za-z_$]{1,2}$/.test(m[3]) && m[3] !== m[2]) {
          return `${m[1] ?? ''}${m[2]}`;
        }
        return s;
      })} };`,
  );
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** The full normalized snapshot for a built `dist/` directory. */
export function buildApiSnapshot(distDir = path.join(ROOT, 'dist')) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`no build at ${distDir}; run \`npm run build:pkg\` first`);
  }
  const files = fs
    .readdirSync(distDir)
    .filter((name) => name.endsWith('.d.mts'))
    .map((name) => ({
      name: normalizeChunkName(name),
      body: normalizeDeclaration(
        fs.readFileSync(path.join(distDir, name), 'utf8'),
      ),
    }))
    .sort((a, b) =>
      a.name === b.name
        ? a.body.localeCompare(b.body)
        : a.name.localeCompare(b.name),
    );
  if (files.length === 0) {
    throw new Error(`no .d.mts files in ${distDir}`);
  }
  const header =
    '// @ekrooh/bare public type surface (normalized dist/*.d.mts).\n' +
    `// Generated; do not edit. Regenerate: ${UPDATE_COMMAND}\n`;
  return header + files.map((f) => `\n// ==== ${f.name}\n${f.body}\n`).join('');
}

function main(argv) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const distDir = path.resolve(arg('--dist') ?? path.join(ROOT, 'dist'));
  const out = path.resolve(arg('--out') ?? SNAPSHOT_PATH);
  const snapshot = buildApiSnapshot(distDir);
  if (argv.includes('--update')) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, snapshot);
    console.log(`api-snapshot: wrote ${path.relative(ROOT, out)}`);
    return 0;
  }
  const committed = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  if (committed === snapshot) {
    console.log('api-snapshot: public type surface matches');
    return 0;
  }
  console.error(
    committed === null
      ? `api-snapshot: ${path.relative(ROOT, out)} is missing. Run: ${UPDATE_COMMAND}`
      : `api-snapshot: the public type surface changed. Review the diff as a ` +
          `stability-boundary change, then run: ${UPDATE_COMMAND}`,
  );
  return 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
