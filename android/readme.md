# android/ — host library (`:bare-host`)

The Android host for `@less/bare`, published as an AAR. Package
`to.holepunch.bare.android`.

| Class                | Responsibility                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `BareProtocol`       | Kotlin mirror of the binary wire protocol (encode/decode).                                                         |
| `HostIpcCoordinator` | Reads the IPC channel: answers capability queries, dispatches host invokes, relays other envelopes to the WebView. |
| `HostPluginRegistry` | Registers host-side handlers and produces capability rows.                                                         |
| `DefaultHostPlugins` | Registers the canonical host plugin handlers (`core.permissions` stub).                                            |
| `BarePortMessenger`  | WebMessagePort bridge: forwards framed bytes between the WebView and the IPC channel (no JSON re-encoding).        |
| `BareShellMarker`    | Injected `window.BareShell` marker so the web layer can detect the bootstrap bridge.                               |
| `BareWebViewClient`  | Serves packaged assets via `WebViewAssetLoader` with an SPA fallback.                                              |

Build:

```bash
./gradlew :bare-host:build
```

Tests: `src/test/` (JUnit, via `./gradlew :bare-host:testDebugUnitTest`).

Consumers: `examples/android-app` depends on this module and demonstrates the
full host lifecycle (`MainActivity.kt`).

The Bare Kit runtime prebuilt (`prebuilds/android/bare-kit/classes.jar`,
gitignored — fetch with `npm run prebuilds`) ships inside the published AAR:
AGP packages the local jar into the AAR's `libs/` and the native libs from
`prebuilds/android/bare-kit/jni` into `jni/`, so consumers need no prebuilds
download.

Publishing: `io.less:bare-host` to GitHub Packages via
`./gradlew :bare-host:publishMavenAarPublicationToGitHubPackagesRepository`
(`release.yml` does this on tags).
