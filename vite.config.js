import { defineConfig } from 'vite-plus';

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
      transports: 'web/transports/index.ts',
    },
  },
});
