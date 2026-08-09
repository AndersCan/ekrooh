#!/usr/bin/env node
/**
 * Set PLAYWRIGHT_BROWSERS_PATH before the Playwright CLI loads playwright-core.
 * playwright-core resolves the browser directory once at import time; setting the
 * path only in playwright.config.ts is too late when the environment (e.g. Cursor
 * sandbox) already points PLAYWRIGHT_BROWSERS_PATH at an empty cache.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const browsersDir = path.join(root, '.playwright-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;

const cli = path.join(root, 'node_modules', 'playwright', 'cli.js');
const args = process.argv.slice(2);
const command = args[0];

if (command === 'test' && !existsSync(browsersDir)) {
  console.error(
    'Playwright browsers are not installed yet. Run `npm run playwright:install` once before e2e tests.',
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

process.exit(result.status === null ? 1 : result.status);
