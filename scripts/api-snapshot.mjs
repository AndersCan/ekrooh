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
 * - the bundler's minified cross-chunk aliases are resolved: an import
 *   `{ $ as PluginManifest }` is rewritten to the name the chunk really exports
 *   under `$`, and a shared chunk's `export { PluginManifest as $ }` drops `$`.
 *   Entry-file export lists are kept as written (a public rename shows);
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

/** `{ a as b, type c }` -> `[{ type: '', local: 'a', exported: 'b' }, ...]`. */
function parseSpecifiers(list) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(type\s+)?(\S+)(?:\s+as\s+(\S+))?$/.exec(s);
      if (!m) throw new Error(`api-snapshot: cannot parse specifier '${s}'`);
      return { type: m[1] ? 'type ' : '', local: m[2], exported: m[3] ?? m[2] };
    });
}

function printSpecifiers(specs) {
  return specs
    .map(({ type, local, exported }) =>
      local === exported ? `${type}${local}` : `${type}${local} as ${exported}`,
    )
    .sort()
    .join(', ');
}

const IMPORT_RE =
  /import\s*(type\s*)?\{([^}]*)\}\s*from\s*(["'])(\.\/[^"']+)\3;?/g;
const LOCAL_EXPORT_RE = /export\s*(type\s*)?\{([^}]*)\}(?!\s*from);?/g;

/** A chunk's export map: exported (minified) name -> the declared name. */
export function chunkExportMap(source) {
  const map = new Map();
  for (const m of stripComments(source).matchAll(LOCAL_EXPORT_RE)) {
    for (const spec of parseSpecifiers(m[2]))
      map.set(spec.exported, spec.local);
  }
  return map;
}

/**
 * One normalized declaration file.
 *
 * `chunkExports` maps a chunk specifier (`./index-HASH.mjs`) to that chunk's
 * export map. An import binding `{ $ as PluginManifest }` is resolved through
 * it to the declared name it really binds (`PluginManifest`), so a build that
 * binds a different type under the same local name changes the snapshot. A
 * shared chunk's own export list drops its minified aliases (they are the
 * bundler's, not the API's); an entry file's export list is kept verbatim, so
 * renaming a public export (`PluginBus as PB`) is a visible change.
 */
export function normalizeDeclaration(
  source,
  { isEntry = true, chunkExports = new Map() } = {},
) {
  let text = stripComments(source);
  text = text.replace(IMPORT_RE, (_m, type, names, _q, from) => {
    const exportsOf = chunkExports.get(from);
    const specs = parseSpecifiers(names).map((spec) => {
      if (!exportsOf) return spec;
      const declared = exportsOf.get(spec.local);
      if (declared === undefined) {
        throw new Error(
          `api-snapshot: '${spec.local}' is not exported by ${from}`,
        );
      }
      return { ...spec, local: declared };
    });
    return `import ${type ?? ''}{ ${printSpecifiers(specs)} } from "${normalizeChunkName(from)}";`;
  });
  text = text.replace(LOCAL_EXPORT_RE, (_m, type, names) => {
    let specs = parseSpecifiers(names);
    if (!isEntry)
      specs = specs.map((spec) => ({ ...spec, exported: spec.local }));
    return `export ${type ?? ''}{ ${printSpecifiers(specs)} };`;
  });
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
  const raw = fs
    .readdirSync(distDir)
    .filter((name) => name.endsWith('.d.mts'))
    .map((name) => ({
      name,
      source: fs.readFileSync(path.join(distDir, name), 'utf8'),
    }));
  if (raw.length === 0) {
    throw new Error(`no .d.mts files in ${distDir}`);
  }
  const isEntry = (name) => ENTRY_NAMES.has(name.replace(/\.d\.mts$/, ''));
  const chunkExports = new Map(
    raw
      .filter((f) => !isEntry(f.name))
      .map((f) => [
        `./${f.name.replace(/\.d\.mts$/, '.mjs')}`,
        chunkExportMap(f.source),
      ]),
  );
  const files = raw
    .map((f) => ({
      name: normalizeChunkName(f.name),
      body: normalizeDeclaration(f.source, {
        isEntry: isEntry(f.name),
        chunkExports,
      }),
    }))
    .sort((a, b) =>
      a.name === b.name
        ? a.body.localeCompare(b.body)
        : a.name.localeCompare(b.name),
    );
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
