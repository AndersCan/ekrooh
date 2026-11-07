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

Publishing: `io.github.anderscan.ekrooh:bare-host` to Maven Central (`:bare-host:publishToSonatype closeAndReleaseSonatypeStagingRepository`), with GitHub Packages as a fallback (`:bare-host:publishMavenAarPublicationToGitHubPackagesRepository`); the `publish-maven` job of `.github/workflows/release.yml` runs them on tags (see `RELEASING.md`).
