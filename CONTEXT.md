# @ekrooh/bare

The boring bootstrap for cross-platform apps on the Bare runtime: a wire protocol, plugin contracts, transports, and native host bridges. This context is the framework's own development — the document set and conventions that govern how the repo is built and maintained.

## Language

**Agent-primary development**:
Development and maintenance of this repo is done primarily by AI agents; humans review and steer. The document set (`vision.md`, `AGENTS.md`, `RELEASING.md`) is written first for those agents, secondarily for human contributors.
_Avoid_: "AI-assisted", "automated" (implies agents are a side channel)

**Stability boundary**:
One of the four public API surfaces gated by the major-version contract: the binary wire protocol, plugin manifest/event contracts, the JS exported surface (`package.json` `exports`), and the Kotlin host public API. Breaking a stability boundary is a major-version event; everything else is implementation.
_Avoid_: "public API" alone (too broad — includes stable internals)

**Testing contract**:
The set of gates every change must pass before it ships: the presence manifest, the coverage floor, the public-API snapshot, and export-surface integrity. Enforcement is mechanical — the gates _are_ tests; prose alone has no force with an agent reader.
_Avoid_: "test coverage requirement" (ambiguous — includes metrics-only regimes)

**Presence manifest**:
The structural rule that every framework-core module (`core/messages`, `core/lib`, `core/server`, `plugins/*`, `web/transports`) ships a co-located `*.test.ts`, barring an explicit exempt list (barrel `index.ts` files, generated bundles, entry points). Catches untested modules the moment they appear.
_Avoid_: "test-per-module rule"

**Coverage floor**:
The no-regress threshold on statement/line/function coverage over the covered set only (`all: false`, include `core/**`, `plugins/**`, `web/**`), anchored to the day's measured values. Branches are reported but not gated. Never gates over generated bundles or entry points.
_Avoid_: "coverage requirement" alone

**Public API snapshot**:
The contract test that freezes the exact exported names of each `@ekrooh/bare` subpath, so an accidental break of a stability boundary fails CI as a test, not a review note.
_Avoid_: "API test" (too generic)
