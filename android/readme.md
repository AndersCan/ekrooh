# android/: host library (`:bare-host`)

Android host for `@ekrooh/bare`, published as an AAR. Package `to.holepunch.bare.android`; sources in `src/main/java/to/holepunch/bare/android/`.

- `BareProtocol`: Kotlin mirror of the wire protocol.
- `HostIpcCoordinator`: answers capability queries, dispatches host invokes.
- `HostPluginRegistry`: host-side handlers and capability rows.
- `DefaultHostPlugins`: canonical host handlers (`core.permissions` stub).
- `BareHandoff`: parses `handoff.json` and deletes it as it reads it.
- `BareHostAbi`: `requireSupportedAbi()` fails fast on a 32-bit runtime or process.
- `BareWebViewClient`: confines the main frame to `allowedOrigin` (GET, POST, external links only on a user gesture) and logs WebView resource errors.

The public Kotlin API is dumped to `api/bare-host.api`; `./gradlew check` runs `apiCheck`. After an intended, reviewed change run `./gradlew :bare-host:apiDump` and commit the diff. Gradle dependency verification is on (`gradle/verification-metadata.xml`); regenerate it after a dependency bump with the command in the root `build.gradle`.

```bash
./gradlew :bare-host:build
./gradlew :bare-host:testDebugUnitTest   # JUnit tests in src/test/
```

Reference consumer: `examples/android-app` (`BareApplication.kt`, `ReferenceHost.kt`, `MainActivity.kt`). The Bare Kit prebuilt (`prebuilds/android/bare-kit/`, gitignored, from `npm run prebuilds`) is packaged into the AAR.

Publishing: `io.github.anderscan.ekrooh:bare-host` to Maven Central (`:bare-host:publishToSonatype closeAndReleaseSonatypeStagingRepository`), with GitHub Packages as a fallback (`:bare-host:publishMavenAarPublicationToGitHubPackagesRepository`); the `publish-maven` job of `.github/workflows/release.yml` runs them on tags (see `RELEASING.md`).
