# Autonomy model: owner starts all work, agents execute, CI is the only judge

## Context

`CONTEXT.md` defines development as agent-primary, but did not say who initiates
work, what an agent may merge on its own, or how releases happen. An `opencode`
comment-triggered workflow existed as a partial answer and was stale. The owner
wants to control only the high-level API, its feel, and requirements, and to
delegate everything internal. Out of scope: which agent or model runs the work.

## Decision

- **The owner starts all work.** There is no self-generated backlog and no
  scheduled agent loop. `.github/workflows/opencode.yml` is removed.
- **Routine upkeep is a housekeeping script**, run when the owner asks
  (for example "update dependencies"). Scripts are deterministic; an agent steps
  in only to repair a failure.
- **CI is the only judge of done, and tests run on GitHub CI, not on a local
  machine.** Local machines change constantly and make results flaky, so a local
  run is a fast hint at most and never evidence that a change works. Anything that
  needs a platform (emulator, simulator, two peers) is a CI job, not a local
  recipe. Required checks: `vp check`, `vp test`,
  Playwright e2e, Android emulator and iOS simulator journeys (ekrooh#23), and a
  two-peer p2p test, all in GitHub CI.
- **Agents merge their own PRs when green**, except an owner-gated change, enforced
  by `CODEOWNERS` and branch protection, not prose (see ADR 0001).
- **Requirements and feel live in the charter** (`docs/api-charter.md`), whose
  examples run as tests.
- **Releases come from a release PR** that a deterministic script opens and updates
  when the unreleased changelog is non-empty. Merging it tags and publishes. Major
  bumps wait for the owner. justus building against the release candidate is a
  required check on the release PR only.

## Consequences

- New work to build: the charter and its executable examples, `CODEOWNERS` and
  branch protection, the emulator/simulator/p2p CI jobs, the release-PR script, the
  iOS checksum gate named in `RELEASING.md`, and justus as a release gate.
- `RELEASING.md` step 3 (manual tag) is superseded once the release-PR script
  lands; until then it stays authoritative.
- Known CI gaps at the time of this decision: the Android emulator job is
  disabled (#44, `adb: device offline`), and `smoke:p2p` and the consumer e2e
  (`test:e2e:consumer`) do not run in CI. Closing these is the first build item.
- Without the real-platform CI jobs, green does not prove the library works, so
  self-merge must not be enabled until they exist.
