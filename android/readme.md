# android/ — host library (`:bare-host`)

The Android host for `@ekrooh/bare`, published as an AAR. Package
`to.holepunch.bare.android`.

| Class                | Responsibility                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `BareProtocol`       | Kotlin mirror of the binary wire protocol (encode/decode).                                                              |
| `HostIpcCoordinator` | Reads the IPC channel: answers capability queries and dispatches host invokes (the web layer uses the loopback socket). |
| `HostPluginRegistry` | Registers host-side handlers and produces capability rows.                                                              |
| `DefaultHostPlugins` | Registers the canonical host plugin handlers (`core.permissions` stub).                                                 |
| `BareWebViewClient`  | Logs WebView resource errors (the worklet serves the page over loopback).                                               |

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

Publishing: `io.ekrooh:bare-host` to GitHub Packages via
`./gradlew :bare-host:publishMavenAarPublicationToGitHubPackagesRepository`
(`release.yml` does this on tags).
