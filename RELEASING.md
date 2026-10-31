# Releasing

Releases are **tag-driven and single-version**: one semver `vX.Y.Z` for the whole
framework, one changelog, one release note. An agent can cut a release from this
document with no human step beyond the tag decision.

## Rules

- One version across npm (`@ekrooh/bare`), the Android AAR, and every artifact.
- Breaking a stability boundary ([`vision.md`](vision.md#stability-contract)) requires a **major** bump.
- Release from `main`. Everything merged must already pass `vp check`, `vp test`,
  and `./gradlew build` (CI enforces this).
- Never publish from a dirty worktree, and never publish an artifact CI did not
  build from the tag. If a gate fails, stop, fix it, and tag again.

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
   plugin event contracts, and the Kotlin host API. The last is reviewed by hand;
   the snapshot pins only JS export names.
4. (Android) `npm run prebuilds` then `./gradlew :examples:android-app:assembleDebug`.
5. (iOS) `npm run build:ios` then `npm run test:ios`. CI's macOS job also covers this.

### iOS binary artifact

Nothing to do per release. The root `Package.swift` always resolves
`BareKit.xcframework` by `url` + `checksum`, on `main` and on every tag, so
there is no form to switch and nothing to restore afterwards. The asset is the
zip of the pinned bare-kit prebuild, pinned in `scripts/prebuilds.lock.json`
under `spm`. It only changes when bare-kit is bumped, which is why its URL may
name an older ekrooh tag. Never delete the release that hosts it: SwiftPM
consumers of every tag that names it would stop resolving.

#### Bumping Bare Kit

Only when the pinned bare-kit version changes (not part of a normal release):

1. Update `version` and the `prebuilds.zip` hash in `scripts/prebuilds.lock.json`
   (and the default in `scripts/fetch-prebuilds.mjs`), then `npm run prebuilds`.
2. `cd prebuilds/ios && zip -r BareKit.xcframework.zip BareKit.xcframework`
3. Host it: `gh release create bare-kit-<version> --latest=false --title "Bare Kit <version> (SwiftPM binary)" --notes "BareKit.xcframework for Package.swift" prebuilds/ios/BareKit.xcframework.zip`.
   The tag does not match `v*`, so `release.yml` does not run.
4. Set the new `url` and `shasum -a 256` of the zip in both `scripts/prebuilds.lock.json`
   (`spm`) and `Package.swift` in the same PR. `security.test.ts` fails if they differ.

## 2. Version and changelog

1. Bump `version` in the root `package.json`. It is the single source; Gradle reads it too.
   Follow [Keep a Changelog](https://keepachangelog.com/) in `CHANGELOG.md`, creating it on the first release.
2. Update `AGENTS.md` or `README.md` only if behavior or commands changed.

## 3. Tag and publish

1. Commit the bump and changelog as `chore: release vX.Y.Z`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. Create a GitHub release from the tag (title `vX.Y.Z`, body = changelog entry).
   `release.yml` publishes on the tag:

   - **npm** (`@ekrooh/bare`): `npm publish --access public` via npm Trusted
     Publishing (OIDC). `release.yml` sets `permissions: id-token: write`. There is
     no `NPM_TOKEN`. Prereleases (for example `0.1.0-beta.1`) get a dist-tag from the
     identifier (`beta`). Stable versions get `latest`. `prepack` and
     `prepublishOnly` run `npm run build:pkg`, so publishing always builds.
   - **Android AAR**: `io.github.anderscan.ekrooh:bare-host` to Maven Central
     (`:bare-host:publishToSonatype closeAndReleaseSonatypeStagingRepository`), plus
     GitHub Packages as a fallback (automatic `GITHUB_TOKEN`). Consumers need no
     credentials. The AAR bundles the Bare Kit runtime jar (`libs/`) and native libs (`jni/`).
   - **Prebuilds**: published upstream by `holepunchto/bare-kit`. This repo never publishes them.
   - **iOS host**: git-fetchable Swift package (`BareHost`, root `Package.swift`)
     on the same tag, with the xcframework artifact from the section above.

   **One-time Maven Central setup (human, before the first Central publish):**
   sign in at <https://central.sonatype.com> with GitHub to verify the
   `io.github.anderscan` namespace. Add repo secrets `SONATYPE_USERNAME` and
   `SONATYPE_PASSWORD` (Account, Generate User Token), `SIGNING_KEY` (ASCII-armored,
   `gpg --armor --export-secret-keys <id>`), and `SIGNING_PASSWORD`. Upload the public
   key with `gpg --keyserver keyserver.ubuntu.com --send-keys <id>`.

The `@ekrooh/bare` exports map is frozen at first publish (beta): `core`, `runtime`,
`plugins`, `plugins/*/events`, and `transports` (WebSocket and mock only). Every
entry points at compiled `dist/` output.

## 4. Announce

1. Confirm the tag's CI run is green.
2. Link the release from the repository home.
