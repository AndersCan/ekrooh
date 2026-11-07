# Releasing

Releases are **tag-driven and single-version**: one semver `vX.Y.Z` for the whole
framework, one changelog, one release note. An agent can cut a release from this
document with no human step beyond the tag decision.

## Rules

- One version across npm (`@ekrooh/bare`), the `bare-host` AAR, and every artifact,
  except the Bare Kit runtime binaries (iOS `BareKit.xcframework.zip` and Android
  `bare-kit-runtime`), which are versioned by bare-kit and published only when it
  is bumped ([ADR 0007](docs/adr/0007-separate-bare-kit-runtime-artifact.md)).
- Breaking a stability boundary ([`vision.md`](vision.md#stability-contract)) requires a **major** bump. While the version is `0.x`, a breaking change
  bumps the **minor** instead (ADR 0006 shipped as 0.6.0).
- Release from `main`. Everything merged must already pass `vp check`, `vp test`,
  and `./gradlew build` (the `main` ruleset requires these checks).
- The tag must name a commit on `main` and equal `v` + the `package.json` version.
  `release.yml` refuses anything else before it builds.
- Never publish from a dirty worktree, and never publish an artifact CI did not
  build from the tag. If a gate fails, stop, fix it, and tag again.
- Only the owner can push `v*` tags (tag ruleset "Release tags"), and nothing
  publishes until the owner approves the `release` environment.

## 1. Prepare

1. `git status` is clean and `main` is up to date.
2. Verify gates locally:

   ```bash
   vp install
   npm run build:pkg
   vp check
   vp test
   npm run test:e2e:web
   ```

3. Confirm the four stability boundaries are unchanged since the beta freeze:
   the wire `VERSION` (pinned by `contract.test.ts`), the JS exports map, the
   plugin event contracts, and the Kotlin host API. `contract.test.ts` pins the
   exports keys, value names and the type surface (`api/public-api.d.mts.snap`);
   `apiCheck` pins the Kotlin API (`android/api/bare-host.api`) and
   `security.apple.test.ts` the Swift API (`ios/public-api.swift.snap`). Review
   any diff to them since the last release as a stability-boundary change.
4. (Android) `npm run prebuilds` then `./gradlew :examples:android-app:assembleDebug`.
   `npm run prebuilds` needs only Node and `unzip`, no token.
5. (iOS) `npm run build:ios` then `npm run test:ios`. CI's macOS job also covers this.

### Bare Kit runtime artifacts (iOS and Android)

Nothing to do per release. The root `Package.swift` always resolves
`BareKit.xcframework` by `url` + `checksum`, on `main` and on every tag, so
there is no form to switch and nothing to restore afterwards. The asset is the
zip of the pinned bare-kit prebuild, pinned in `scripts/prebuilds.lock.json`
under `spm`. It only changes when bare-kit is bumped, which is why its URL may
name an older ekrooh tag (bare-kit v2.5.5 is hosted on the `v0.6.0` release).
Never delete the release that hosts it: SwiftPM consumers of every tag that
names it would stop resolving. The checksum pins the bytes; the `ios` CI job
pins the contents: `.github/scripts/verify-spm-binary.mjs` fails unless the zip
unpacks to exactly the SHA-256-verified upstream `ios/BareKit.xcframework`.

Android works the same way. `bare-host` depends on
`io.github.anderscan.ekrooh:bare-kit-runtime` at the `maven` pin in
`scripts/prebuilds.lock.json`. That AAR is the ~70 MB upstream prebuild, and
Maven Central limits each organization's release size per month, so it is
published only by `release-bare-kit-runtime.yml` on a `bare-kit-v<pin>` tag,
never on `vX.Y.Z`. `release.yml` fails before publishing anything if the pinned
`bare-kit-runtime` is not on Maven Central yet.

#### Bumping Bare Kit

Only when the pinned bare-kit version changes (not part of a normal release):

Do it in one PR. `<version>` is the bare-kit tag, for example `v2.5.6`.

1. Update `version` and the `prebuilds.zip` hash in `scripts/prebuilds.lock.json`
   (the only place either is written), set `maven["bare-kit-runtime"]` to the
   version without the `v` (`2.5.6`), then `npm run prebuilds`. Check the new
   hash against the upstream release before you record it.
2. `cd prebuilds/ios && zip -r BareKit.xcframework.zip BareKit.xcframework`
3. Set the `spm` `url` to
   `https://github.com/AndersCan/ekrooh/releases/download/bare-kit-<version>/BareKit.xcframework.zip`
   and its `shasum -a 256` in both `scripts/prebuilds.lock.json` and `Package.swift`.
   `security.test.ts` fails if they differ, and the `ios` CI job fails if the zip's
   contents are not the verified prebuild. Push the PR branch.
4. Tag the PR head and host the zip:
   `gh release create bare-kit-<version> --target <pr-branch> --latest=false --title "Bare Kit <version>" --notes "BareKit.xcframework for Package.swift; bare-kit-runtime for Android" prebuilds/ios/BareKit.xcframework.zip`.
   The tag runs `release-bare-kit-runtime.yml`, which checks that the tag matches the
   `maven` pin and publishes `bare-kit-runtime` to Maven Central (approve it in the
   `release` environment). It does not match `v*`, so `release.yml` does not run.
5. Merge once CI is green, including the iOS job that resolves the new zip.
   Cut the next `vX.Y.Z` only after `bare-kit-runtime` shows up on
   `repo1.maven.org` (Central can take about 30 minutes to sync).

To republish the same bare-kit version (a packaging fix), set the pin to
`<version>-1` (then `-2`, ...) and push `bare-kit-v<pin>`. Central versions are immutable.

## 2. Version and changelog

1. Bump `version` in the root `package.json`. It is the single source; Gradle reads it too.
   Follow [Keep a Changelog](https://keepachangelog.com/) in `CHANGELOG.md`, creating it on the first release.
2. Update `AGENTS.md` or `README.md` only if behavior or commands changed.

## 3. Tag and publish

1. Commit the bump and changelog as `chore: release vX.Y.Z`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. Create a GitHub release from the tag (title `vX.Y.Z`, body = changelog entry).
4. Approve the `release` environment when the run asks (one approval covers
   both publish jobs).

   `release.yml` runs three jobs on the tag:

   - **build** (no secrets, no OIDC, read-only token): checks the tag (equals the
     version, is on `main`), runs `build:pkg`, `docs:check`, `vp check`, `vp test`,
     fetches the prebuilds, runs `npm run build` and `./gradlew build`, then packs
     the npm tarball (`npm pack`, which runs `prepack`) and uploads it and the
     release AAR as run artifacts.
   - **publish-npm** (`release` environment, `id-token: write`): publishes the
     packed tarball with `npm publish <tgz> --ignore-scripts` via npm Trusted
     Publishing (OIDC). No checkout, install or build runs in this job, and there
     is no `NPM_TOKEN`. Prereleases (for example `0.1.0-beta.1`) get a dist-tag
     from the identifier (`beta`). Stable versions get `latest`.
   - **publish-maven** (`release` environment, signing and Sonatype secrets): runs
     only the Gradle publish tasks below, with no npm install or JS build. Those
     tasks rebuild the AAR (with Gradle dependency verification on,
     `gradle/verification-metadata.xml`), so Gradle and its plugins still run next to the
     secrets; the wrapper is validated in the job.
   - **Android AAR**: `io.github.anderscan.ekrooh:bare-host` to Maven Central
     (`:bare-host:publishToSonatype closeAndReleaseSonatypeStagingRepository`), plus
     GitHub Packages as a fallback (automatic `GITHUB_TOKEN`). Consumers need no
     credentials. The AAR holds only ekrooh code (about 40 KB). The Bare Kit runtime
     comes from its `bare-kit-runtime` dependency (see above).
   - **Prebuilds**: published upstream by `holepunchto/bare-kit`. This repo never publishes them.
   - **iOS host**: git-fetchable Swift package (`BareHost`, root `Package.swift`)
     on the same tag, with the xcframework artifact from the section above.

   **One-time Maven Central setup (human, before the first Central publish):**
   sign in at <https://central.sonatype.com> with GitHub to verify the
   `io.github.anderscan` namespace. Add **`release` environment** secrets (never
   repo secrets, which any branch's workflow can read) `SONATYPE_USERNAME` and
   `SONATYPE_PASSWORD` (Account, Generate User Token), `SIGNING_KEY` (ASCII-armored,
   `gpg --armor --export-secret-keys <id>`), and `SIGNING_PASSWORD`. Upload the public
   key with `gpg --keyserver keyserver.ubuntu.com --send-keys <id>`. The `release`
   environment needs the owner as required reviewer and a deployment policy that
   allows only tags `v*`.

The `@ekrooh/bare` exports map is frozen at first publish (beta): `core`, `runtime`,
`plugins`, `plugins/*/events`, and `transports` (WebSocket and mock only). Every
entry points at compiled `dist/` output.

## 4. Announce

1. Confirm the tag's Release run is green (its `build` job ran every gate).
2. Link the release from the repository home.

## 5. Bump the starter

`examples/vote` pins the published packages, so it moves only after a release.

1. After the release run is green, check that `npm view @ekrooh/bare@X.Y.Z version`
   prints `X.Y.Z` and that
   `https://repo1.maven.org/maven2/io/github/anderscan/ekrooh/bare-host/X.Y.Z/` exists.
2. In `examples/vote`, set the same version in four places (keep them equal):
   - `@ekrooh/bare` in `package.json`, then run `npm install` to update the lockfile.
   - `bare-host:X.Y.Z` in `android/app/build.gradle`.
   - `exactVersion: X.Y.Z` in `ios/project.yml`.
   - `version = X.Y.Z;` in `ios/Vote.xcodeproj/project.pbxproj`.
3. On macOS, run `npm run sync` in `examples/vote`. If it reports changed native
   packages (the bare-link xcframework set differs from `project.pbxproj`), edit the
   `framework:` entries in `ios/project.yml`, run `xcodegen generate`, and commit the
   regenerated `ios/Vote.xcodeproj`.
4. Open a PR titled `chore: bump examples/vote to vX.Y.Z`. The Starter workflow builds
   web, Android and iOS from the published packages.
