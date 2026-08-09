# Releasing

Releases are **tag-driven and single-version**: one semver `vX.Y.Z` for the
whole framework, one changelog, one release note. An AI agent should be able to
cut a release by following this document with no human beyond the tag decision.

## Rules

- One version across JS (`@less/bare`), the Android AAR, and every artifact.
- Breaking changes (wire protocol, plugin contracts, JS exports, Kotlin host
  API — see `vision.md`) require a **major** bump.
- Releases are created from `main`. Everything merged to `main` must already
  pass `vp check`, `vp test`, and `./gradlew build` (CI enforces this).

## Checklist

### 1. Prepare

1. Make sure `git status` is clean and `main` is up to date.
2. Verify the gates locally:

   ```bash
   npm ci
   vp check
   npm run test
   ```

3. (Android) fetch prebuilds and build the APK:

   ```bash
   npm run prebuilds
   ./gradlew :examples:android-app:assembleDebug
   ```

### 2. Version and changelog

1. Bump `version` in the root `package.json` (the single source of the version).
   Follow [Keep a Changelog](https://keepachangelog.com/) in `CHANGELOG.md` —
   create it on the first release.
2. Update `AGENTS.md`/`README.md` only if behavior or commands changed.

### 3. Tag and release

1. Commit the version bump and changelog as `chore: release vX.Y.Z`.
2. Create the tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

3. Create a GitHub release from the tag (title `vX.Y.Z`, body = the changelog
   entry). A release workflow **should** then publish all artifacts; until that
   workflow exists, publish manually:

   - **npm** (`@less/bare`): `npm publish` from the repo root. This claims the
     reserved name on the first release. The package ships TypeScript source
     via its `exports` map — consumers must bundle it (Vite, esbuild, or
     bare-pack); plain-Node execution is not supported.
   - **Android AAR**: not yet publishable — `:bare-host` is compiled against a
     locally fetched Bare Kit prebuilt (`prebuilds/`, see `android/readme.md`).
     Publishing to GitHub Packages is blocked on packaging the bare-kit runtime
     into the AAR; revisit when that is resolved. (Vision.md marks this
     artifact as pending.)
   - **Prebuilds**: already published upstream by `holepunchto/bare-kit`; this
     repo never publishes them.

### 4. Announce

1. Confirm the tag's CI run is green.
2. Link the release from the repository home.

## Notes for agents

- Never publish from a dirty worktree.
- Never publish an artifact that CI did not build from the tag.
- If a gate fails at any point, stop and fix the failure before tagging again.
