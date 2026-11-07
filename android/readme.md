# android/: host library (`:bare-host`)

Android host for `@ekrooh/bare`, published as an AAR. Package `to.holepunch.bare.android`; sources in `src/main/java/to/holepunch/bare/android/`.

- `BareProtocol`: Kotlin mirror of the wire protocol.
- `HostIpcCoordinator`: answers capability queries, dispatches host invokes.
- `HostPluginRegistry`: host-side handlers and capability rows.
- `DefaultHostPlugins`: canonical host handlers (`core.permissions` stub).
- `BareWebViewClient`: logs WebView resource errors.

```bash
./gradlew :bare-host:build
./gradlew :bare-host:testDebugUnitTest   # JUnit tests in src/test/
```

Reference consumer: `examples/android-app` (`MainActivity.kt`). The Bare Kit prebuilt (`prebuilds/android/bare-kit/`, gitignored, from `npm run prebuilds`) is packaged by `bare-kit-runtime/` (`:bare-kit-runtime`) as `io.github.anderscan.ekrooh:bare-kit-runtime`, which `:bare-host` depends on. It is published separately, only when bare-kit is bumped (ADR 0007).

Publishing: `io.github.anderscan.ekrooh:bare-host` to Maven Central (and GitHub Packages) from `.github/workflows/release.yml` on `v*` tags; `io.github.anderscan.ekrooh:bare-kit-runtime` from `.github/workflows/release-bare-kit-runtime.yml` on `bare-kit-v*` tags. See `RELEASING.md`.
