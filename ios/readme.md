# ios/ — host library (`BareHost`)

The iOS host for `@less/bare`, mirroring the Kotlin host
(`android/.../to/holepunch/bare/android`). Distributed as a Swift package
depending on `bare-kit-swift`; the runtime binary (`BareKit.xcframework`) is
embedded by the consuming app.

| Swift type           | Mirrors                 | Responsibility                                                                                                                                  |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `BareProtocol`       | `BareProtocol.kt`       | Binary wire protocol (envelope encode/decode + `buildErrorResponse`).                                                                           |
| `HostIpcCoordinator` | `HostIpcCoordinator.kt` | Reads the IPC channel: answers capability queries, dispatches host invokes, relays every other envelope to the web layer as the original bytes. |
| `HostPluginRegistry` | `HostPluginRegistry.kt` | Registers host-side handlers and produces capability rows (`runtimes: ["ios"]`).                                                                |
| `DefaultHostPlugins` | `DefaultHostPlugins.kt` | Registers the canonical host plugin handlers (`core.permissions` stub).                                                                         |
| `BareWebViewBridge`  | `BarePortMessenger.kt`  | WKWebView bridge: base64 frames via `WKScriptMessageHandler` + injected `window.onBareMessage` (no `WebMessagePort` on iOS).                    |
| `ErrorCodes`         | `ErrorCodes.kt`         | Canonical error codes, kept in sync with `core/messages/constants.ts`.                                                                          |

Tests: `Tests/BareHostTests/` (XCTest mirroring the JUnit suite) plus the
reference app's UI test (`examples/ios-app/UITests`), run on the simulator via:

```bash
npm run prebuilds      # prebuilds/ios/BareKit.xcframework (gitignored)
npm run build:ios      # addons/, Resources/, ios-app.xcodeproj
npm run test:ios       # xcodebuild test on the simulator
```

Consumers embed `BareHost` (SPM) plus `BareKit.xcframework` and the linked
addon frameworks; see `examples/ios-app` for the full host lifecycle.

The package is iOS-only (`.iOS(.v14)`), matching the bare-kit runtime's
`MinimumOSVersion` (14.0).
