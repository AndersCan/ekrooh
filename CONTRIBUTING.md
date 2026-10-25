# Contributing

Thanks for contributing to **`@ekrooh/bare`**. Humans and agents alike: read
[`vision.md`](vision.md) first. If a change conflicts with it, the vision wins.
Agents also read [`AGENTS.md`](AGENTS.md), the operating manual.

## Setup

```bash
vp install
npm run playwright:install   # once, for e2e
npm run prebuilds            # once, for the Android build (needs gh)
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

   For integration changes, also run `npm run test:e2e:web`.

4. For Android changes, run `./gradlew build`.
5. Push and open a PR to `main`. CI runs the JS gate, the Playwright suite, and the Android build.

## Commits

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `build:`).
- One logical change per commit.
- Never commit build output (see [`AGENTS.md`](AGENTS.md)).

## Style

- `vp check` runs the formatter (oxfmt), linter (oxlint), and `tsc`. Run it before pushing.
- TypeScript is strict.
