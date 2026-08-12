import { defineConfig } from 'vite-plus';

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
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
      ],
      reporter: ['text'],
      thresholds: {
        statements: 80,
        functions: 75,
        lines: 80,
      },
    },
  },
});
