# ios/ — host library (`BareHost`)

The iOS host for `@ekrooh/bare`, mirroring the Kotlin host
(`android/.../to/holepunch/bare/android`). It ships as a **git-fetchable Swift
package** from the repo root (`Package.swift`), so consumers add it as a normal
SPM dependency from the ekrooh release tag — **no sibling checkout, no
cross-repo npm step**.

To keep the Swift host able to resolve `<BareKit/BareKit.h>` with **no
consumer build settings**, the package is self-contained: it bundles the
runtime binary (`BareKit.xcframework`) as a SwiftPM `.binaryTarget` and vendors
the small `bare-kit-swift` layer (`Worklet`/`IPC` in `Sources/BareKit` + the
ObjC bridge in `Sources/BareKitBridge`, Apache-2.0, from
`holepunchto/bare-kit-swift`). A cross-package binary target would not
propagate the framework search path to a separate `bare-kit-swift` dependency,
so vendoring is what removes the `FRAMEWORK_SEARCH_PATHS` friction.

| Swift type           | Mirrors                 | Responsibility                                                                                                          |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `BareProtocol`       | `BareProtocol.kt`       | Binary wire protocol (envelope encode/decode + `buildErrorResponse`).                                                   |
| `HostIpcCoordinator` | `HostIpcCoordinator.kt` | Reads the IPC channel: answers capability queries and dispatches host invokes (the web layer uses the loopback socket). |
| `HostPluginRegistry` | `HostPluginRegistry.kt` | Registers host-side handlers and produces capability rows (`runtimes: ["ios"]`).                                        |
| `DefaultHostPlugins` | `DefaultHostPlugins.kt` | Registers the canonical host plugin handlers (`core.permissions` stub).                                                 |
| `ErrorCodes`         | `ErrorCodes.kt`         | Canonical error codes, kept in sync with `core/messages/constants.ts`.                                                  |

Tests: `Tests/BareHostTests/` (XCTest mirroring the JUnit suite) plus the
reference app's UI test (`examples/ios-app/UITests`), run on the simulator via:

```bash
npm run prebuilds      # prebuilds/ios/BareKit.xcframework (gitignored)
npm run build:ios      # addons/, Resources/, ios-app.xcodeproj
npm run test:ios       # xcodebuild test on the simulator
```

The package is iOS-only (`.iOS(.v14)`), matching the bare-kit runtime's
`MinimumOSVersion` (14.0).

## Consuming from a Swift Package

Add the root package at an exact ekrooh tag (one line, pure SPM — the runtime
`BareKit` binary resolves through the same tag):

```swift
// swift-tools-version: 5.10
dependencies: [
  .package(
    url: "https://github.com/AndersCan/ekrooh",
    exact: "X.Y.Z"   // the same vX.Y.Z tag that ships the BareKit binary
  ),
]
```

Targets:

```swift
.product(name: "BareHost", package: "ekrooh"),  // the host
.product(name: "BareKit",  package: "ekrooh"),  // Worklet/IPC + ObjC bridge
```

No `FRAMEWORK_SEARCH_PATHS` or `LD_RUNPATH_SEARCH_PATHS` are required at
compile time — the vendored bridge resolves `<BareKit/BareKit.h>` from the
bundled `.binaryTarget`. The `bare-link --preset ios` step is only for the
**app-specific native addons** (below), not for the crate itself.

> The committed `Package.swift` pins the `.binaryTarget` to a **path**
> (`prebuilds/ios/BareKit.xcframework`) for in-repo dev + CI. At release time
> (`RELEASING.md`) it is swapped to the published `url` + `checksum` artifact
> on the matching tag. Consumers always get the `url` form from the tag.

## Embedding the runtime + addons in an app

SwiftPM links `BareKit` but does not embed the dynamic framework into the app
bundle, so an **app target** (as opposed to a library) must still:

1. **Embed `BareKit`** — add the resolved `BareKit` framework (or the
   `BareKit.xcframework` from the release artifact) to the app's **Embed
   Frameworks** copy phase. Without it, the app links but crashes at launch
   (`Library not loaded`). `LD_RUNPATH_SEARCH_PATHS` defaults to
   `@executable_path/Frameworks` in embedded apps, so no manual setting is
   needed for the standard layout.
2. **Embed the native addons** produced by the `bare-link --preset ios`
   contract — the per-consumer xcframeworks that link the JS deps (bare-*,
   rocksdb, sodium, udx, fs-native-extensions, quickbit, rabin, simdle) into
   the Bare runtime. They are enumerated explicitly in the app's Embed
   Frameworks phase (xcodegen can't glob framework deps). Run:
   `npx bare-link --preset ios --out <app>/addons` and embed every emitted
   `*.xcframework`. See `scripts/build-ios-app.mjs` + `examples/ios-app`
   `project.yml` for the canonical setup.

For the simplest plumbing, mirror the reference app: an SPM dependency on the
root package + `Embed Frameworks` entries for `BareKit` and the addons.

## Reference app

`examples/ios-app` consumes the root package by **local path** (`../..`)
because it lives in the same monorepo; external consumers use the git URL
above. It wires a real picker/camera (`PHPickerViewController` +
`UIImagePickerController`) and real permissions
(`AVCaptureDevice.requestAccess`). See `examples/ios-app/project.yml` for the
full `bare-link` addon enumeration.
