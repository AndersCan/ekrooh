#!/usr/bin/env node
/**
 * Run the iOS host XCTest suite (`ios/Tests/BareHostTests`) on the simulator
 * via the reference app's `ios-app` scheme.
 *
 * Usage:
 *   node scripts/test-ios.mjs
 *
 * Picks the first available iPhone simulator so the command is portable across
 * Xcode versions. Requires the generated project and resources
 * (`npm run build:ios`) plus `prebuilds/ios` (`npm run prebuilds`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = path.join(root, 'examples/ios-app/ios-app.xcodeproj');

if (
  !existsSync(path.join(root, 'examples/ios-app/Resources/main.core.bundle'))
) {
  console.error(
    'Missing examples/ios-app/Resources/. Run `npm run build:ios` first ' +
      '(and `npm run prebuilds` once for prebuilds/ios/BareKit.xcframework).',
  );
  process.exit(1);
}

const devices = JSON.parse(
  execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
    encoding: 'utf8',
  }),
);

const name = Object.values(devices.devices)
  .flat()
  .find((device) => device.name.includes('iPhone'))?.name;

if (!name) {
  console.error('No available iPhone simulator found.');
  process.exit(1);
}

console.log(`Running tests on ${name}...`);
execFileSync(
  'xcodebuild',
  [
    'test',
    '-project',
    project,
    '-scheme',
    'ios-app',
    '-destination',
    `platform=iOS Simulator,name=${name}`,
  ],
  { cwd: root, stdio: 'inherit' },
);
