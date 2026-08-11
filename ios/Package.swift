// swift-tools-version: 5.10

import PackageDescription

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
  ],
  dependencies: [
    // Swift bindings (`Worklet`, `IPC`) for the Bare Kit runtime. The binary
    // itself (`BareKit.xcframework`, fetched into `prebuilds/ios/` by
    // `scripts/fetch-prebuilds.mjs`) must be embedded by the consuming app;
    // the SPM package provides the typed wrappers and the
    // `.linkedFramework("BareKit")` link instruction.
    .package(
      url: "https://github.com/holepunchto/bare-kit-swift",
      revision: "ef26bbde9bb47eaebeb4e50944306b4ff23934ce"
    ),
  ],
  targets: [
    .target(
      name: "BareHost",
      dependencies: [
        .product(name: "BareKit", package: "bare-kit-swift"),
      ]
    ),
  ]
)
