// swift-tools-version: 5.10

import PackageDescription

// The iOS host (`BareHost`) as a git-fetchable Swift package, so consumers can
// add it as a normal SPM dependency from the ekrooh release tag — no sibling
// checkout, no cross-repo npm step.
//
// The Bare Kit runtime (`BareKit.xcframework`) is bundled as a SwiftPM binary
// target, always in `url` + `checksum` form — in this working tree, in CI, and
// on every tag — so nothing is switched at release time. The asset is the zip
// of the pinned bare-kit prebuild (`scripts/prebuilds.lock.json` → `spm`): it
// changes only when bare-kit is bumped, not per ekrooh release, which is why
// the URL can name an older tag. `security.test.ts` keeps the pair in sync
// with the lockfile. Bumping bare-kit: RELEASING.md, "Bumping Bare Kit".
//
// `bare-kit-swift` (holepunchto) is vendored in as `BareKit` (`Worklet`/`IPC`)
// and `BareKitBridge` (ObjC bridge) targets. Vendoring — rather than a git
// dependency on the upstream package — is what lets the `BareKitBridge` ObjC
// target see the bundled framework's headers via the `.binaryTarget`'s `-F`:
// a cross-package binary target does not propagate the framework search path
// to the upstream package's bridge target (verified), so the consumer would
// otherwise still have to set `FRAMEWORK_SEARCH_PATHS`.
let package = Package(
  name: "BareHost",
  // The Bare Kit runtime (BareKit.xcframework) declares MinimumOSVersion 14.0
  // and ships no macOS slice, so the host is iOS-only.
  platforms: [.iOS(.v14)],
  products: [
    .library(
      name: "BareHost",
      targets: ["BareHost"]
    ),
    // Re-exports the vendored Worklet/IPC + ObjC bridge so `import BareKit`
    // keeps working exactly as it did via the upstream bare-kit-swift product.
    .library(
      name: "BareKit",
      targets: ["BareKit"]
    ),
  ],
  targets: [
    .binaryTarget(
      name: "BareKitBinary",
      url: "https://github.com/AndersCan/ekrooh/releases/download/v0.6.0/BareKit.xcframework.zip",
      checksum: "cb3f1f309942ff0abf9b6bd729dcaf2406c035edae43868338ea709aae32e2a2"
    ),
    .target(
      name: "BareKitBridge",
      dependencies: ["BareKitBinary"],
      path: "ios/Sources/BareKitBridge",
      linkerSettings: [
        .linkedFramework("BareKit")
      ]
    ),
    .target(
      name: "BareKit",
      dependencies: ["BareKitBridge"],
      path: "ios/Sources/BareKit"
    ),
    .target(
      name: "BareHost",
      dependencies: ["BareKit"],
      path: "ios/Sources/BareHost"
    ),
    .testTarget(
      name: "BareHostTests",
      dependencies: ["BareHost", "BareKit"],
      path: "ios/Tests/BareHostTests"
    ),
  ]
)
