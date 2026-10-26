#!/usr/bin/env node
/**
 * Build the reference desktop app (gitignored output).
 *
 * macOS:
 *
 *   examples/desktop-app/dist/Ekrooh.app
 *     Contents/MacOS/ekrooh               Zig host (zig build)
 *     Contents/Resources/bare             sidecar Bare runtime
 *     Contents/Resources/desktop.bundle   packed backend (bare-pack)
 *     Contents/Resources/node_modules/    native addons offloaded by bare-pack
 *     Contents/Resources/WebAssets/       the reference web build
 *
 * Linux (x64 or arm64; needs libgtk-3-dev and libwebkit2gtk-4.1-dev):
 *
 *   examples/desktop-app/dist/ekrooh-linux-<arch>/
 *     bin/ekrooh                          Zig host (zig build)
 *     resources/{bare,desktop.bundle,node_modules,WebAssets}
 *   examples/desktop-app/dist/ekrooh-linux-<arch>.tar.gz (+ .sha256)
 *
 * No Node, Bun or other runtime is needed to RUN the result; they are only
 * build-time tools. The Linux build also needs the system's WebKitGTK at run
 * time.
 *
 * Usage:
 *   node scripts/build-desktop-app.mjs [--skip-web]
 *
 * Requires `zig` (>= 0.17) on PATH.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.join(root, 'examples/desktop-app');

const minMacos = '12.0';
const hosts = {
  darwin: { arm64: 'darwin-arm64', x64: 'darwin-x64' },
  linux: { arm64: 'linux-arm64', x64: 'linux-x64' },
};
const host = hosts[process.platform]?.[process.arch];
if (!host) {
  console.error('The desktop reference app builds on macOS and Linux only.');
  process.exit(1);
}
const isMac = process.platform === 'darwin';

// Where the host, its resources and (macOS only) Info.plist go.
const outDir = isMac
  ? path.join(appDir, 'dist/Ekrooh.app')
  : path.join(appDir, `dist/ekrooh-${host}`);
const resources = path.join(outDir, isMac ? 'Contents/Resources' : 'resources');
const hostDir = path.join(outDir, isMac ? 'Contents/MacOS' : 'bin');

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

rmSync(outDir, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
mkdirSync(hostDir, { recursive: true });

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
const zigArch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
const zigArgs = ['build', '-Doptimize=ReleaseSafe'];
if (isMac) {
  // An explicit target pins the deployment target to LSMinimumSystemVersion
  // below; a native build would stamp the build machine's macOS as the minimum.
  const sdk = execFileSync('xcrun', ['--show-sdk-path'], {
    encoding: 'utf8',
  }).trim();
  zigArgs.push(`-Dtarget=${zigArch}-macos.${minMacos}`, `-Dsdk=${sdk}`);
}
// Linux builds natively: the system GTK/WebKit headers and the build machine's
// glibc are what the result links against. Build on the oldest distro you
// intend to support (CI uses ubuntu-22.04).
run('zig', zigArgs, appDir);
copyFileSync(
  path.join(appDir, 'zig-out/bin/ekrooh'),
  path.join(hostDir, 'ekrooh'),
);
chmodSync(path.join(hostDir, 'ekrooh'), 0o755);

if (isMac) {
  writeFileSync(
    path.join(outDir, 'Contents/Info.plist'),
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
  <key>LSMinimumSystemVersion</key><string>${minMacos}</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
  );

  console.log('Ad-hoc signing...');
  run('codesign', ['--force', '--deep', '--sign', '-', outDir]);
} else {
  console.log('Creating the tarball...');
  const name = path.basename(outDir);
  const tarball = `${name}.tar.gz`;
  run('tar', ['-czf', tarball, name], path.dirname(outDir));
  const digest = createHash('sha256')
    .update(readFileSync(path.join(path.dirname(outDir), tarball)))
    .digest('hex');
  writeFileSync(
    path.join(path.dirname(outDir), `${tarball}.sha256`),
    `${digest}  ${tarball}\n`,
  );
}

console.log(`Done: ${path.relative(root, outDir)}`);
