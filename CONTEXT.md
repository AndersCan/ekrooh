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

## Autonomy

**Charter**:
The human-owned document (`docs/api-charter.md`) stating how the framework's API should feel, with worked good and bad examples that are also executable. Agents conform to it; only the owner edits it.
_Avoid_: "style guide", "requirements doc"

**Owner-gated change**:
A change that touches a stability boundary, `vision.md`, the charter, an ADR, or the CI workflows, and therefore waits for the owner instead of merging itself. Every other change merges itself once all gates are green.
_Avoid_: "protected file", "manual review"

**Housekeeping script**:
A deterministic, owner-triggered script for routine upkeep (dependency updates, runtime bumps). It is not an agent loop; an agent is involved only to repair a failure.
_Avoid_: "maintenance bot", "agent loop"

**Release PR**:
The single pull request, opened and kept current by a deterministic script whenever there are unreleased changes, whose merge cuts the release. Merging it is the owner's only release decision, and a major release always waits for the owner.
_Avoid_: "release branch", "release ticket"

**Release gate**:
A check required to merge a Release PR but not an ordinary change. The downstream app (justus) building against the release candidate is the release gate.
_Avoid_: "canary job"

## Loopback runtime

**Loopback gate**:
The module (`core/server/loopback-gate.ts`) that decides admission to the loopback server: the session token, the single-use bootstrap nonce, the session cookie and the origin rule. Every HTTP request, WebSocket upgrade and `/login` asks it for a verdict.
_Avoid_: "auth middleware", "session service"

**Origin rule**:
The check that a request targets the bound loopback server (`Host`) and comes from an allowed page (`Origin`). It applies with auth on or off.
_Avoid_: "CORS" (the server sends no CORS headers; WebSocket upgrades are not covered by CORS)

**Protocol socket slot**:
The single live protocol WebSocket of a loopback server (`core/server/protocol-socket.ts`): handshake, one-client replacement rule, bounded writes and server push.
_Avoid_: "connection manager"

**Frame channel**:
One framed byte stream to a peer (`core/messages/frame-channel.ts`): reassembles frames, routes requests through the plugin router and writes responses, with a declared malformed-frame policy (`close` for the WebSocket, `tolerate` for the host IPC).
_Avoid_: "pipe", "connection handler"
