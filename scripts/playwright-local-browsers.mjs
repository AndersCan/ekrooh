#!/usr/bin/env node
/**
 * Set PLAYWRIGHT_BROWSERS_PATH before the Playwright CLI loads playwright-core.
 * playwright-core resolves the browser directory once at import time; setting the
 * path only in playwright.config.ts is too late when the environment (e.g. Cursor
 * sandbox) already points PLAYWRIGHT_BROWSERS_PATH at an empty cache.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.playwright-browsers');

const cli = path.join(root, 'node_modules', 'playwright', 'cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

process.exit(result.status === null ? 1 : result.status);
