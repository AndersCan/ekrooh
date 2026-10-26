// swift-tools-version: 5.10

import PackageDescription

// The iOS host (`BareHost`) as a git-fetchable Swift package, so consumers can
// add it as a normal SPM dependency from the ekrooh release tag — no sibling
// checkout, no cross-repo npm step.
//
// The Bare Kit runtime (`BareKit.xcframework`) is bundled as a SwiftPM binary
// target. In this working tree (and CI) it resolves from the gitignored
// `prebuilds/ios/` via the `path` below; at release time (`RELEASING.md`) the
// binary target is switched to a published `url` + `checksum` artifact on the
// matching `vX.Y.Z` tag so consumers resolve it purely from SwiftPM.
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
      // Path form for in-repo dev + CI (prebuilds on disk, gitignored). See
      // RELEASING.md for the release-time switch to url + checksum against
      // the vX.Y.Z tag artifact.
      name: "BareKitBinary",
      path: "prebuilds/ios/BareKit.xcframework"
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
