import { defineConfig, devices } from '@playwright/test';

const port = process.env.CONSUMER_BASIC_PORT ?? '8080';

/**
 * Real-stack e2e for the consumer example (issue #33, pattern from docs
 * hosts/testing.mdx): boots the worklet serving the BUILT web app from its
 * loopback server — the same-origin topology that runs on device — and drives
 * Playwright against `http://127.0.0.1:<port>`, asserting the invoke + push
 * roundtrip and no console errors.
 *
 * Run from the repo root: `CONSUMER_BASIC_PORT=8091 npm run test:e2e:consumer`
 * (the wrapper script in scripts/playwright-local-browsers.mjs sets the
 * hermetic browser dir and runs the CLI with the repo as cwd).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command:
      'npm run build:web && node scripts/boot-worklet.mjs --web-assets dist/web',
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      CONSUMER_BASIC_PORT: port,
    },
  },
});
