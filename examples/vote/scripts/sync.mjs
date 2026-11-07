#!/usr/bin/env node
/**
 * `npm run sync`: builds the page and the app backend and copies everything
 * the Android and iOS projects need (web build, bundle, native addons).
 */
import { build as esbuild } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workletSource = path.join(root, 'worklet', 'entry.ts');
const workletOut = path.join(root, 'worklet', 'app.core.gen.js');
const webDist = path.join(root, 'dist', 'web');
const iosRoot = path.join(root, 'ios');
const androidMain = path.join(root, 'android', 'app', 'src', 'main');

function fail(reason) {
  console.log(`[vote] ${reason}`);
  process.exit(1);
}

function runCli(pkg, args) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules', pkg, 'bin.js'), ...args],
    { stdio: 'inherit', cwd: root },
  );
  if (result.status !== 0) {
    fail(`${pkg} failed (exit ${result.status ?? 'signal'}).`);
  }
}

function countFiles(dir, suffix) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full, suffix);
    else if (entry.name.endsWith(suffix)) count += 1;
  }
  return count;
}

if (!fs.existsSync(path.join(root, 'node_modules', 'bare-pack'))) {
  fail('Run "npm install" first.');
}

console.log('[vote] Building the page');
try {
  await viteBuild({ root, logLevel: 'warn' });
} catch (error) {
  fail(`Page build failed: ${error instanceof Error ? error.message : error}`);
}

console.log('[vote] Bundling the app backend');
try {
  await esbuild({
    entryPoints: [workletSource],
    outfile: workletOut,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
  });
} catch (error) {
  fail(
    `Backend build failed: ${error instanceof Error ? error.message : error}`,
  );
}

console.log('[vote] Android: copying the page and packing the backend');
const assets = path.join(androidMain, 'assets');
fs.rmSync(path.join(assets, 'web'), { recursive: true, force: true });
fs.mkdirSync(assets, { recursive: true });
fs.cpSync(webDist, path.join(assets, 'web'), { recursive: true });
runCli('bare-pack', [
  '--preset',
  'android',
  '--out',
  path.join(assets, 'main.core.bundle'),
  workletOut,
]);

console.log('[vote] Android: linking native addons');
const addons = path.join(androidMain, 'addons');
fs.rmSync(addons, { recursive: true, force: true });
runCli('bare-link', ['--preset', 'android', '--out', addons]);
if (countFiles(addons, '.so') === 0) {
  fail(
    'bare-link linked no native addons. Use npm (not pnpm/yarn): delete node_modules and run npm install.',
  );
}

if (process.platform !== 'darwin') {
  console.log('[vote] Skipped iOS: it needs macOS.');
  console.log('Synced web build to android/. Press Run in Android Studio.');
  process.exit(0);
}

console.log('[vote] iOS: copying the page and packing the backend');
const iosApp = path.join(iosRoot, 'Vote');
fs.rmSync(path.join(iosApp, 'WebAssets'), { recursive: true, force: true });
fs.cpSync(webDist, path.join(iosApp, 'WebAssets'), { recursive: true });
fs.rmSync(path.join(iosApp, 'main.core.bundle'), { force: true });
runCli('bare-pack', [
  '--preset',
  'ios',
  '--out',
  path.join(iosApp, 'main.core.bundle'),
  workletOut,
]);

console.log('[vote] iOS: linking native addons');
const iosAddons = path.join(iosRoot, 'addons');
fs.rmSync(iosAddons, { recursive: true, force: true });
runCli('bare-link', ['--preset', 'ios', '--out', iosAddons]);

const linked = new Set(
  fs.readdirSync(iosAddons).filter((name) => name.endsWith('.xcframework')),
);
const pbxproj = fs.readFileSync(
  path.join(iosRoot, 'Vote.xcodeproj', 'project.pbxproj'),
  'utf8',
);
const listed = new Set(
  [...pbxproj.matchAll(/addons\/([^"\/]+\.xcframework)/g)].map((m) => m[1]),
);
const same =
  linked.size === listed.size && [...linked].every((name) => listed.has(name));
if (!same) {
  fail(
    `iOS native packages changed. bare-link produced: ${[...linked].sort().join(', ')}. The Xcode project lists: ${[...listed].sort().join(', ')}. Update the framework list in ios/project.yml and regenerate the project (see RELEASING.md, "Bump the starter").`,
  );
}

console.log(
  'Synced web build to android/ and ios/. Press Run in Android Studio or Xcode.',
);
