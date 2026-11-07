# Contributing

Thanks for contributing to **`@ekrooh/bare`**. Humans and agents alike: read
[`vision.md`](vision.md) first. If a change conflicts with it, the vision wins.
Agents also read [`AGENTS.md`](AGENTS.md), the operating manual.

## Setup

```bash
vp install
npm run playwright:install   # once, for e2e
npm run prebuilds            # once, for the Android build (Node + unzip, no token)
```

The repo is a Vite+ (npm) workspace plus a Gradle multi-module build. `vp` is a local dependency.

## Making changes

1. Branch from `main`. Keep the change small and within the module boundaries in `vision.md`.
2. Add or update tests:
   - Unit: `*.test.ts` next to the code (`core/messages`, `web/transports`, and so on).
   - Kotlin host: `android/src/test/`.
   - End to end: `e2e/*.spec.ts`.
3. Run the gate:

   ```bash
   npm run build:pkg
   vp check
   vp test
   ```

   For integration changes, also run `npm run test:e2e:web`. For docs changes,
   run `npm run docs:check` (after `build:pkg`): every ```ts snippet in
   `apps/docs` is type-checked against `dist/`, so declare what a snippet uses
   (`declare const bus: PluginBus;`) or mark an intentionally partial one with
   `{/* docs-check: skip */}` on the line before the fence.

4. For Android changes, run `./gradlew build` (it runs `:bare-host:apiCheck`).
   - A changed Kotlin public API fails `apiCheck`. If the change is intended
     and reviewed, run `./gradlew :bare-host:apiDump` and commit
     `android/api/bare-host.api`.
   - Gradle dependency verification is on. After bumping a Gradle dependency
     or plugin, regenerate `gradle/verification-metadata.xml` with the command
     in the root `build.gradle` and review the diff.
   - A changed JS type surface fails `contract.test.ts`: after review, run
     `npm run build:pkg && npm run api:snapshot`. A changed Swift API fails
     `security.apple.test.ts`: after review, `vp test security.apple.test.ts -u`.
5. Push and open a PR to `main`. CI runs the JS gate (including `docs:check`), the
   Playwright suite, the Android, iOS, desktop and p2p jobs, and the security scans.
   `main` requires those checks, one approval and a code-owner review
   (`.github/CODEOWNERS`). A docs-only change (Markdown, `docs/`, `LICENSE`) skips
   the heavy jobs; they report as skipped, which counts as passing.

## Commits

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `build:`).
- One logical change per commit.
- Never commit build output (see [`AGENTS.md`](AGENTS.md)).

## Style

- `vp check` runs the formatter (oxfmt), linter (oxlint), and `tsc`. Run it before pushing.
- TypeScript is strict.
