#!/usr/bin/env node
/**
 * Build the macOS reference desktop app (gitignored output):
 *
 *   examples/desktop-app/dist/Ekrooh.app
 *     Contents/MacOS/ekrooh               Zig host (zig build)
 *     Contents/Resources/bare             sidecar Bare runtime
 *     Contents/Resources/desktop.bundle   packed backend (bare-pack)
 *     Contents/Resources/node_modules/    native addons offloaded by bare-pack
 *     Contents/Resources/WebAssets/       the reference web build
 *
 * No Node, Bun or other runtime is needed to RUN the result; they are only
 * build-time tools.
 *
 * Usage:
 *   node scripts/build-desktop-app.mjs [--skip-web]
 *
 * Requires `zig` (>= 0.17) on PATH. Apple Silicon or Intel macOS only for now.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.join(root, 'examples/desktop-app');
const bundleDir = path.join(appDir, 'dist/Ekrooh.app');
const resources = path.join(bundleDir, 'Contents/Resources');
const macosDir = path.join(bundleDir, 'Contents/MacOS');

const hosts = { arm64: 'darwin-arm64', x64: 'darwin-x64' };
const host = hosts[process.arch];
if (process.platform !== 'darwin' || !host) {
  console.error('The desktop reference app only builds on macOS for now.');
  process.exit(1);
}

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });

console.log('Building the desktop backend entry...');
run('node_modules/.bin/esbuild', [
  'core/desktop.core.ts',
  '--bundle',
  '--packages=external',
  '--platform=node',
  '--format=esm',
  '--outfile=core/desktop.core.gen.js',
]);

rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
mkdirSync(macosDir, { recursive: true });

console.log(`Packing desktop.bundle for ${host} (addons offloaded)...`);
run('node_modules/.bin/bare-pack', [
  '--host',
  host,
  '--offload-addons',
  '--out',
  path.join(resources, 'desktop.bundle'),
  'core/desktop.core.gen.js',
]);

console.log('Copying the sidecar bare runtime...');
const bareSrc = createRequire(import.meta.url)('bare-runtime')();
const bareDst = path.join(resources, 'bare');
copyFileSync(bareSrc, bareDst);
// Some installs drop the executable bit on the npm-packaged binary.
chmodSync(bareDst, 0o755);

if (!process.argv.includes('--skip-web')) {
  console.log('Building web assets...');
  run('npm', ['run', 'build:web']);
}
const webBuildOut = path.join(root, 'examples/android-app/src/main/assets');
if (!existsSync(path.join(webBuildOut, 'index.html'))) {
  console.error(`No web build at ${webBuildOut}; run \`npm run build:web\`.`);
  process.exit(1);
}
const webAssets = path.join(resources, 'WebAssets');
mkdirSync(webAssets, { recursive: true });
cpSync(
  path.join(webBuildOut, 'index.html'),
  path.join(webAssets, 'index.html'),
);
cpSync(path.join(webBuildOut, 'assets'), path.join(webAssets, 'assets'), {
  recursive: true,
});

console.log('Building the Zig host...');
run('zig', ['build', '-Doptimize=ReleaseSafe'], appDir);
copyFileSync(
  path.join(appDir, 'zig-out/bin/ekrooh'),
  path.join(macosDir, 'ekrooh'),
);
chmodSync(path.join(macosDir, 'ekrooh'), 0o755);

writeFileSync(
  path.join(bundleDir, 'Contents/Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Ekrooh</string>
  <key>CFBundleIdentifier</key><string>to.holepunch.bare.desktop</string>
  <key>CFBundleExecutable</key><string>ekrooh</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
);

console.log('Ad-hoc signing...');
run('codesign', ['--force', '--deep', '--sign', '-', bundleDir]);

console.log(`Done: ${path.relative(root, bundleDir)}`);
