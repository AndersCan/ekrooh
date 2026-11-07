# Mechanical enforcement of the stability and testing contract

## Decision

The stability and testing contract in `vision.md` is enforced by the test suite,
not by prose:

- Each framework-core module ships a co-located `*.test.ts` (presence manifest).
- Coverage floor: `all: false` over `core/**`, `plugins/**`, `web/**`, anchored to
  day-one values. Branches are reported, not gated.
- The public API surface is frozen by a snapshot test.
- `package.json` `exports`/`files` entries must resolve to real paths.
- Nothing is gated over generated or entry-point files.

## Status note (2026-11, security review)

The enforcement has grown; the decision is unchanged:

- The public API snapshot now covers **types and signatures**, not only value
  names: `contract.test.ts` compares the built `dist/*.d.mts` surface with the
  committed `api/public-api.d.mts.snap` (regenerate after a reviewed change
  with `npm run build:pkg && npm run api:snapshot`). The normalizer resolves
  chunk aliases to their declarations and keeps each entry's export list
  verbatim, so a rebuild with new chunk hashes is not a diff but any type or
  signature change is.
- The `package.json` `exports` **keys** are frozen too: a new subpath fails the
  test, because it is a new stability boundary.
- The host APIs are pinned the same way: the Kotlin API by
  `android/api/bare-host.api` (`./gradlew :bare-host:apiDump`, checked by
  `apiCheck` in `./gradlew check`), the Swift API by `ios/public-api.swift.snap`
  (`vp test security.apple.test.ts -u`).
- The coverage floor is no longer `all: false`: Vitest 5 has no such option and
  counts every file matching `include` (`core/**/*.ts`, `plugins/**/*.ts`,
  `web/**/*.ts`), so an untested module shows as 0%. The floor is anchored to
  the measured values rounded down (statements 91, functions 92, lines 93) and
  is raised when coverage rises; branches stay ungated.

## Rationale

The repo is agent-primary. A drifted claim in prose loses all force against an agent
that trusts the CI gate. A pure percentage gate was rejected: it is gameable and
drowns in generated bundles. The presence manifest covers structure, and the floor
covers depth.
