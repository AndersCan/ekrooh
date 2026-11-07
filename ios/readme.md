# ios/: host library (`BareHost`)

iOS host for `@ekrooh/bare`, mirroring the Kotlin host. It is a git-fetchable Swift package; the manifest is `Package.swift` at the repo root.

The package is self-contained. It bundles `BareKit.xcframework` as a `.binaryTarget` and vendors the `bare-kit-swift` layer (Apache-2.0, from `holepunchto/bare-kit-swift`), so consumers need no `FRAMEWORK_SEARCH_PATHS`. Targets iOS 14.

| Swift type                                        | Mirrors                 | Responsibility                                                           |
| ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `BareProtocol`                                    | `BareProtocol.kt`       | Wire protocol encode/decode, `buildErrorResponse`.                       |
| `HostIpcCoordinator`                              | `HostIpcCoordinator.kt` | Answers capability queries, dispatches host invokes.                     |
| `HostPluginRegistry`                              | `HostPluginRegistry.kt` | Host handlers and capability rows (`runtimes: ["ios"]`).                 |
| `DefaultHostPlugins`                              | `DefaultHostPlugins.kt` | Canonical host handlers (`core.permissions` stub).                       |
| `ErrorCodes`                                      | `ErrorCodes.kt`         | Kept in sync with `core/messages/constants.ts`.                          |
| `BareStorage`                                     | `ReferenceHost.kt`      | Storage in Application Support (no backup), cache in Caches.             |
| `BareHandoff`                                     | `BareHandoff.kt`        | Parses and deletes `handoff.json`; bootstrap user script.                |
| `BareNavigationDelegate` / `BareNavigationPolicy` | `BareWebViewClient.kt`  | Loopback-origin confinement (`loadInPlace` for same-origin new windows). |
| `BareWebHost`                                     | —                       | `configure` (WebView hardening), `load` (bootstrap + first load).        |
| `HostIpcRouter`                                   | `HostIpcCoordinator.kt` | Field validation, timeouts (`maxInvokeTimeout` 1 day).                   |

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

SwiftPM does not embed the addon frameworks. An app target must:

1. Let Xcode embed `BareKit` through the package product (xcodegen: a single `- package: BareHost`). Do not embed the prebuild a second time ("Multiple commands produce .../BareKit.framework").
2. Embed every `*.xcframework` emitted by `npx bare-link --preset ios --out <app>/addons`. List them explicitly; xcodegen cannot glob them. Canonical setup: `scripts/build-ios-app.mjs` and `examples/ios-app/project.yml`.

`examples/ios-app` depends on the root package by local path (`../..`) and uses the library's `BareStorage`, `BareHandoff`, `BareNavigationDelegate` and `BareWebHost`.

The public Swift API is pinned by `ios/public-api.swift.snap` (`security.apple.test.ts`). After an intended, reviewed change: `vp test security.apple.test.ts -u`.
