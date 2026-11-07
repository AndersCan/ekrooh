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

Reference consumer: `examples/android-app` (`BareApplication.kt`, `ReferenceHost.kt`, `MainActivity.kt`). The Bare Kit prebuilt (`prebuilds/android/bare-kit/`, gitignored, from `npm run prebuilds`) is packaged by `bare-kit-runtime/` (`:bare-kit-runtime`) as `io.github.anderscan.ekrooh:bare-kit-runtime`, which `:bare-host` depends on. It is published separately, only when bare-kit is bumped (ADR 0007).

Publishing: `io.github.anderscan.ekrooh:bare-host` to Maven Central, with GitHub Packages as a fallback, from `.github/workflows/release.yml` on `v*` tags. Gradle only stages the unsigned publication (`:bare-host:publishMavenAarPublicationToLocalStagingRepository`, into `build/maven-staging`); `.github/scripts/publish-maven.sh` signs and uploads it in a job that runs no Gradle. `io.github.anderscan.ekrooh:bare-kit-runtime` is published by `.github/workflows/release-bare-kit-runtime.yml` on `bare-kit-v*` tags. See `RELEASING.md`.
