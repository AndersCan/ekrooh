#!/usr/bin/env node
/**
 * Build the generated (gitignored) inputs for the iOS reference app:
 *
 *   - `examples/ios-app/addons/*.xcframework`   (`bare-link --preset ios`)
 *   - `examples/ios-app/Resources/main.core.bundle` (`bare-pack --preset ios`)
 *   - `examples/ios-app/Resources/WebAssets/`   (copy of the web build output)
 *
 * and (re)generate `examples/ios-app/ios-app.xcodeproj` via xcodegen.
 *
 * Usage:
 *   node scripts/build-ios-app.mjs
 *
 * Requires the Bare Kit prebuilds (`npm run prebuilds`) and `xcodegen`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.join(root, 'examples/ios-app');
const addonsDir = path.join(appDir, 'addons');
const resourcesDir = path.join(appDir, 'Resources');
const webAssetsDir = path.join(resourcesDir, 'WebAssets');
const xcframework = path.join(root, 'prebuilds/ios/BareKit.xcframework');

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });

if (!existsSync(xcframework)) {
  console.error(
    'Missing prebuilds/ios/BareKit.xcframework. Run `npm run prebuilds` first.',
  );
  process.exit(1);
}

console.log('Building the worklet bundle (build:core)...');
run('npm', ['run', 'build:core']);

console.log('Linking native addons for iOS...');
rmSync(addonsDir, { recursive: true, force: true });
mkdirSync(addonsDir, { recursive: true });
run('node_modules/.bin/bare-link', [
  '--preset',
  'ios',
  '--out',
  'examples/ios-app/addons',
]);

console.log('Packing main.core.bundle for iOS...');
mkdirSync(resourcesDir, { recursive: true });
run('node_modules/.bin/bare-pack', [
  '--preset',
  'ios',
  '--out',
  'examples/ios-app/Resources/main.core.bundle',
  'core/main.core.gen.js',
]);

console.log('Building + packing the p2p verify worklet (ticket #24)...');
run('node_modules/.bin/esbuild', [
  'core/p2p-verify.core.ts',
  '--bundle',
  '--packages=external',
  '--platform=node',
  '--format=esm',
  '--outfile=core/p2p-verify.core.gen.js',
]);
run('node_modules/.bin/bare-pack', [
  '--preset',
  'ios',
  '--out',
  'examples/ios-app/Resources/p2p-verify.bundle',
  'core/p2p-verify.core.gen.js',
]);

console.log('Building web assets...');
run('npm', ['run', 'build:web']);

console.log('Copying web assets into Resources/WebAssets...');
rmSync(webAssetsDir, { recursive: true, force: true });
mkdirSync(webAssetsDir, { recursive: true });
const webBuildOut = path.join(root, 'examples/android-app/src/main/assets');
cpSync(
  path.join(webBuildOut, 'index.html'),
  path.join(webAssetsDir, 'index.html'),
  { recursive: true },
);
cpSync(path.join(webBuildOut, 'assets'), path.join(webAssetsDir, 'assets'), {
  recursive: true,
});

console.log('Generating ios-app.xcodeproj...');
run('xcodegen', ['generate'], appDir);

console.log(
  'Done. Build/test with: npm run test:ios (or xcodebuild -project examples/ios-app/ios-app.xcodeproj -scheme ios-app ...).',
);
