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

## Rationale

The repo is agent-primary. A drifted claim in prose loses all force against an agent
that trusts the CI gate. A pure percentage gate was rejected: it is gameable and
drowns in generated bundles. The presence manifest covers structure, and the floor
covers depth.
