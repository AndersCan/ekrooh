# Releasing

Releases are **tag-driven and single-version**: one semver `vX.Y.Z` for the
whole framework, one changelog, one release note. An AI agent should be able to
cut a release by following this document with no human beyond the tag decision.

## Rules

- One version across JS (`@ekrooh/bare`), the Android AAR, and every artifact.
- Breaking changes (wire protocol, plugin contracts, JS exports, Kotlin host
  API — see `vision.md`) require a **major** bump.
- Releases are created from `main`. Everything merged to `main` must already
  pass `vp check`, `vp test`, and `./gradlew build` (CI enforces this).

## Checklist

### 1. Prepare

1. Make sure `git status` is clean and `main` is up to date.
2. Verify the gates locally:

   ```bash
   vp install
   npm run build:pkg
   vp check
   vp test
   npm run test:e2e:web
   ```

3. Confirm the four stability boundaries are unchanged since the beta freeze:
   the wire `VERSION` (pinned by `contract.test.ts`), the JS exports map, the
   plugin event contracts, and the Kotlin host API (reviewed manually — the
   snapshot pins JS export names only).
4. (Android) fetch prebuilds and build the APK:

   ```bash
   npm run prebuilds
   ./gradlew :examples:android-app:assembleDebug
   ```

5. (iOS) verify the Swift host on a simulator (also covered by CI on the macOS
   runner):

   ```bash
   npm run build:ios
   npm run test:ios
   ```

   The Swift host ships as source in `ios/` on the tag; CI (`test.yml`, macOS
   job) keeps it green.

### 2. Version and changelog

1. Bump `version` in the root `package.json` (the single source of the version —
   the Gradle publication reads it too). Follow
   [Keep a Changelog](https://keepachangelog.com/) in `CHANGELOG.md` — create it
   on the first release.
2. Update `AGENTS.md`/`README.md` only if behavior or commands changed.

### 3. Tag and release

1. Commit the version bump and changelog as `chore: release vX.Y.Z`.
2. Create the tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. Create a GitHub release from the tag (title `vX.Y.Z`, body = the changelog
   entry). A release workflow (`release.yml`) publishes all artifacts on the
   tag:

   - **npm** (`@ekrooh/bare`): `npm publish --access public` from the repo root
     (`release.yml` does this with the `NPM_TOKEN` secret). Prerelease versions
     (e.g. `0.1.0-beta.1`) publish under a dist-tag derived from the
     prerelease identifier (`beta`), stable versions under `latest`. The first
     publish claims the reserved name. The package ships **compiled ESM JS +
     types** (`dist/`); `prepack`/`prepublishOnly` run `npm run build:pkg`
     (`vp pack`), so publishing always builds. Consumers never receive
     TypeScript source.
   - **Android AAR**: `io.github.anderscan.ekrooh:bare-host` publishes to **Maven Central**
     (`release.yml` runs `:bare-host:publishToSonatype
closeAndReleaseSonatypeStagingRepository` with the `SONATYPE_USERNAME` /
     `SONATYPE_PASSWORD` user-token secrets and the `SIGNING_KEY` /
     `SIGNING_PASSWORD` GPG secrets) and to **GitHub Packages** as a fallback
     (`:bare-host:publishMavenAarPublicationToGitHubPackagesRepository`, no
     extra secrets — automatic `GITHUB_TOKEN`). Consumers need **no
     credentials**: plain `mavenCentral()` resolves the AAR. The AAR is
     self-contained: the Bare Kit runtime jar ships in the AAR's `libs/` and
     its native libs in `jni/`, so consumers need no prebuilds download.

     **One-time Maven Central setup (human, before the first Central publish)**:
     sign in at <https://central.sonatype.com> with GitHub (auto-verifies the
     `io.github.anderscan` namespace). The groupId `io.github.anderscan.ekrooh`
     is a sub-namespace — allowed once the parent is verified. Then add
     these repo secrets:
     `SONATYPE_USERNAME`/`SONATYPE_PASSWORD` (Account → Generate User Token)
     and `SIGNING_KEY` (ASCII-armored private key: `gpg --armor
--export-secret-keys <id>`) / `SIGNING_PASSWORD`. Upload the public key to
     a keyserver (`gpg --keyserver keyserver.ubuntu.com --send-keys <id>`).

   - **Prebuilds**: already published upstream by `holepunchto/bare-kit`; this
     repo never publishes them.
   - **iOS host**: ships as **source** in `ios/` (SPM package `BareHost`,
     consumed by `examples/ios-app`) on the same tag; no separate artifact is
     published until distribution is decided (see `vision.md`). Consumers
     embed `BareKit.xcframework` from `prebuilds/ios/`.

The `@ekrooh/bare` exports map is frozen at first publish (beta): `core`,
`runtime`, `plugins`, `plugins/*/events`, and `transports` (WebSocket + mock
only — the pre-1.0 bootstrap bridges were removed in Phase 2). Every entry
points at the compiled `dist/` output (`build:pkg`), never TypeScript source.

### 4. Announce

1. Confirm the tag's CI run is green.
2. Link the release from the repository home.

## Notes for agents

- Never publish from a dirty worktree.
- Never publish an artifact that CI did not build from the tag.
- If a gate fails at any point, stop and fix the failure before tagging again.
