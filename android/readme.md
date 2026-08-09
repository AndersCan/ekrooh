# android/ — host library (`:bare-host`)

The Android host for `@less/bare`, published as an AAR. Package
`to.holepunch.bare.android`.

| Class                     | Responsibility                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `BareProtocol`            | Kotlin mirror of the binary wire protocol (encode/decode).                                                           |
| `HostIpcCoordinator`      | Reads the IPC channel: answers capability queries, dispatches host invokes, forwards other envelopes to the WebView. |
| `HostPluginRegistry`      | Registers host-side handlers and produces capability rows.                                                           |
| `DefaultHostPlugins`      | Registers the canonical host plugin handlers (`core.permissions` stub).                                              |
| `BareBridge`              | `@JavascriptInterface` bridge: WebView → IPC.                                                                        |
| `WebViewBackendMessenger` | Delivers backend messages to the WebView.                                                                            |
| `BareWebViewClient`       | Serves packaged assets via `WebViewAssetLoader` with an SPA fallback.                                                |

Build:

```bash
./gradlew :bare-host:build
```

Tests: `src/test/` (JUnit, via `./gradlew :bare-host:testDebugUnitTest`).

Consumers: `examples/android-app` depends on this module and demonstrates the
full host lifecycle (`MainActivity.kt`).

Note: this library is compiled against the Bare Kit runtime prebuilt
(`prebuilds/android/bare-kit/classes.jar`, gitignored — fetch with
`npm run prebuilds`). Packaging of that runtime into the published AAR is an
open release question (see `RELEASING.md`).
