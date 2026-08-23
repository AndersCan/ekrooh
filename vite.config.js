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
    ignorePatterns: ['apps/docs/**'],
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
      all: false,
      include: ['core/**', 'plugins/**', 'web/**'],
      exclude: [
        'core/main.core.ts',
        'core/main.core.gen.js',
        'core/harness.core.ts',
        'core/harness.core.gen.js',
        // Dev p2p verification worklet (+ its esbuild bundle): verified via
        // smoke:p2p and the on-device P2PVerifyTest instrumentation/iOS
        // tests, not unit tests.
        'core/p2p-verify.core.ts',
        'core/p2p-verify.core.gen.js',
      ],
      reporter: ['text'],
      thresholds: {
        statements: 80,
        functions: 75,
        lines: 80,
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
    },
  },
});
