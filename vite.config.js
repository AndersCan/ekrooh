import { defineConfig } from 'vite-plus';
import { fileURLToPath } from 'node:url';

const bareStub = (name) =>
  fileURLToPath(new URL(`./test/bare-stubs/stub-${name}.mjs`, import.meta.url));

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ['apps/docs/**', 'examples/vote/**'],
  },
  fmt: {
    trailingComma: 'all',
    tabWidth: 2,
    semi: true,
    singleQuote: true,
    printWidth: 80,
    sortPackageJson: false,
    sortTailwindcss: {},
    ignorePatterns: [
      'prebuilds/*',
      'build/*',
      '.gradle/',
      '.idea/',
      '**/*.bundle',
      'examples/android-app/src/main/assets/**/*',
    ],
  },
  test: {
    root: '.',
    include: ['**/*.test.ts'],
    // The `bare-*` builtins only exist in the Bare runtime; vitest runs in
    // plain Node. Map them to Node equivalents once here so every suite can
    // load (per-file vi.mock stubs remain valid and win where present).
    alias: [
      { find: 'bare-fs', replacement: 'node:fs' },
      { find: 'bare-path', replacement: 'node:path' },
      { find: 'bare-http1', replacement: 'node:http' },
      { find: 'bare-os', replacement: 'node:os' },
      { find: 'bare-encoding', replacement: 'node:util' },
      { find: 'bare-crypto', replacement: bareStub('crypto') },
      { find: 'bare-ws', replacement: bareStub('ws') },
    ],
    coverage: {
      // Vitest 5 counts every file matching `include`, loaded by a test or
      // not (there is no `all` option any more), so an untested module shows
      // up at 0% instead of hiding. TypeScript sources only: readmes and
      // generated bundles are not code under test.
      include: ['core/**/*.ts', 'plugins/**/*.ts', 'web/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'core/main.core.ts',
        'core/main.core.gen.js',
        'core/desktop.core.ts',
        'core/desktop.core.gen.js',
        'core/harness.core.ts',
        'core/harness.core.gen.js',
        // Dev p2p verification worklet (+ its esbuild bundle): verified via
        // smoke:p2p and the on-device P2PVerifyTest instrumentation/iOS
        // tests, not unit tests.
        'core/p2p-verify.core.ts',
        'core/p2p-verify.core.gen.js',
        'core/sync-smoke.core.ts',
        'core/sync-smoke.core.gen.js',
      ],
      reporter: ['text'],
      // No-regress floor: the measured values (2026-11-07, statements 93.75,
      // branches 88.83, functions 93.67, lines 95.38) rounded down by about
      // one point. Raise these when coverage rises.
      thresholds: {
        statements: 92.5,
        branches: 87.5,
        functions: 92.5,
        lines: 94,
      },
    },
  },
  pack: {
    dts: true,
    format: ['esm'],
    entry: {
      index: 'core/messages/index.ts',
      runtime: 'core/runtime.ts',
      plugins: 'plugins/index.ts',
      'plugins-health-events': 'plugins/health/events.ts',
      'plugins-discovery-events': 'plugins/discovery/events.ts',
      'plugins-permissions-events': 'plugins/permissions/events.ts',
      'plugins-media-events': 'plugins/media/events.ts',
      'plugins-logs-events': 'plugins/logs/events.ts',
      transports: 'web/transports/index.ts',
      sync: 'core/sync/create-sync.ts',
    },
  },
});
