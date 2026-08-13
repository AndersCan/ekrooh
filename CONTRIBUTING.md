# Contributing

Thanks for contributing to **`@ekrooh/bare`**. This document is for humans and
agents alike. If you are an agent, `AGENTS.md` is your operating manual and
`vision.md` defines what this project is and is not — read both first.

## Before you start

- **Read `vision.md`.** If a change conflicts with it, the vision wins.
- The repo is a Vite+ (npm) workspace + a Gradle multi-module build. `vp` is
  the toolchain; it is installed as a local dependency, so `npm run` scripts
  work without a global install.

## Getting started

```bash
npm ci
npm run playwright:install   # once, for e2e
npm run prebuilds            # once, for the Android build (needs gh)
```

## Making changes

1. Branch from `main`.
2. Make the change. Keep it small; keep the module boundaries in `vision.md`.
3. Add or update tests:
   - JS unit tests: `*.test.ts` next to the code under `core/messages`, `web/transports`.
   - Kotlin host tests: `android/src/test/`.
   - End-to-end: `e2e/*.spec.ts`.
4. Run the gate:

   ```bash
   vp check        # format + lint + type-check
   npm run test    # unit + e2e
   ```

5. For Android changes, verify locally:

   ```bash
   ./gradlew build
   ```

6. Push and open a PR to `main`. CI runs the JS gate, the Playwright suite,
   and the Android build.

## Commit conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`,
  `refactor:`, `build:`).
- One logical change per commit.
- Never commit build output (see `AGENTS.md`).

## Style

- Oxfmt and Oxlint are enforced by `vp check`. Format before pushing:
  `npm run lint`.
- TypeScript is strict; typecheck is part of `vp check`.
