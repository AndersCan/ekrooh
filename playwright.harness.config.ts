import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const configDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Hermetic browser directory under the repo (gitignored). Mirrors
 * `playwright.config.ts` — always set before playwright-core imports, so this
 * must run via `scripts/playwright-local-browsers.mjs`.
 *
 * @see https://playwright.dev/docs/browsers#hermetic-install
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
  configDir,
  '.playwright-browsers',
);

/**
 * Multi-instance harness journeys (ticket #21): boots the bare harness worklet
 * (`npm run harness:e2e`) and drives one tab per instance against real
 * same-origin WebSockets. Separate config from the mock-transport app e2e
 * (`playwright.config.ts`) because each boots its own server.
 */
export default defineConfig({
  testDir: './e2e/harness',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  use: {
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'harness',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run harness:e2e',
    url: `http://127.0.0.1:${process.env.HARNESS_PORT ?? '8081'}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
