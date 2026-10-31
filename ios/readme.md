# ios/: host library (`BareHost`)

iOS host for `@ekrooh/bare`, mirroring the Kotlin host. It is a git-fetchable Swift package; the manifest is `Package.swift` at the repo root.

The package is self-contained. It bundles `BareKit.xcframework` as a `.binaryTarget` and vendors the `bare-kit-swift` layer (Apache-2.0, from `holepunchto/bare-kit-swift`), so consumers need no `FRAMEWORK_SEARCH_PATHS`. Targets iOS 14.

| Swift type           | Mirrors                 | Responsibility                                           |
| -------------------- | ----------------------- | -------------------------------------------------------- |
| `BareProtocol`       | `BareProtocol.kt`       | Wire protocol encode/decode, `buildErrorResponse`.       |
| `HostIpcCoordinator` | `HostIpcCoordinator.kt` | Answers capability queries, dispatches host invokes.     |
| `HostPluginRegistry` | `HostPluginRegistry.kt` | Host handlers and capability rows (`runtimes: ["ios"]`). |
| `DefaultHostPlugins` | `DefaultHostPlugins.kt` | Canonical host handlers (`core.permissions` stub).       |
| `ErrorCodes`         | `ErrorCodes.kt`         | Kept in sync with `core/messages/constants.ts`.          |

Source: `ios/Sources/BareHost/`. The runtime wrappers are in `ios/Sources/BareKit/` (`Worklet`, `IPC`) and `ios/Sources/BareKitBridge/` (ObjC).

## Test

```bash
npm run prebuilds      # prebuilds/ios/BareKit.xcframework (gitignored)
npm run build:ios      # addons/, Resources/, ios-app.xcodeproj
npm run test:ios       # xcodebuild test on the simulator
```

XCTest unit tests: `ios/Tests/BareHostTests/`. UI tests: `examples/ios-app/UITests`.

## Consume from SwiftPM

```swift
// swift-tools-version: 5.10
dependencies: [
  .package(url: "https://github.com/AndersCan/ekrooh", exact: "X.Y.Z"),
]
// products: .product(name: "BareHost", package: "ekrooh"), .product(name: "BareKit", package: "ekrooh")
```

`Package.swift` resolves the `.binaryTarget` by a fixed `url` and `checksum` (pinned in `scripts/prebuilds.lock.json`), the same on `main` and on every tag. It changes only when bare-kit is bumped (`RELEASING.md`, "Bumping Bare Kit").

## Embed in an app target

SwiftPM links but does not embed dynamic frameworks. An app target must:

1. Add `BareKit` to the Embed Frameworks phase, or the app crashes with `Library not loaded`.
2. Embed every `*.xcframework` emitted by `npx bare-link --preset ios --out <app>/addons`. List them explicitly; xcodegen cannot glob them. Canonical setup: `scripts/build-ios-app.mjs` and `examples/ios-app/project.yml`.

`examples/ios-app` depends on the root package by local path (`../..`).
