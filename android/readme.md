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

Reference consumer: `examples/android-app` (`MainActivity.kt`). The Bare Kit prebuilt (`prebuilds/android/bare-kit/`, gitignored, from `npm run prebuilds`) is packaged into the AAR.

Publishing: `io.ekrooh:bare-host` to GitHub Packages via `./gradlew :bare-host:publishMavenAarPublicationToGitHubPackagesRepository`; `.github/workflows/release.yml` runs it on tags.
