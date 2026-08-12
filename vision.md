# Vision

> This document is the source of truth for what this project **is** and what it
> **is not**. It is written primarily for AI agents that develop and maintain
> this repository, and secondarily for human contributors. If a decision in the
> codebase conflicts with this document, this document wins; change the code,
> not the vision.

## What this is

**`@less/bare`** is a framework that provides the **boring bootstrap** for
cross-platform apps built on the Bare runtime (the holepunch platform). It is
the plumbing — and only the plumbing:

- a binary **wire protocol** (`core/messages`): codec, plugin router, RPC
  messenger
- **plugin contracts** (`plugins`): namespaced events, manifests, deterministic
  errors
- **transports** (`web/transports`): WebSocket, mock
- **native hosts**: Android (Kotlin) and iOS (Swift) — host IPC, plugin
  registry, loopback page load. iOS ships as source (`ios/`, SPM) at Android
  reference parity
- a **reference implementation** (`examples`): a runnable app demonstrating
  every plugin and doubling as the integration test harness

Product features (camera, BLE, auth, storage — beyond the permission
bootstrap) do **not** belong here. Consumers build them as their own plugins on
top of this framework.

## What it is not

| Not this                                               | Because                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| A product app                                          | Consumers add product features as their own plugins                     |
| A general-purpose Android framework or WebView wrapper | This framework is specific to the Bare runtime + its protocol           |
| A desktop implementation                               | Desktop is out of scope                                                 |
| A Node.js application                                  | On device the runtime is Bare (worklet); Node only runs the dev backend |
| A peer-to-peer framework                               | Bare is the runtime; this project is not Pears or a P2P layer           |
| Owned by one app team                                  | It is a distributable framework with multiple consumers                 |

## Distribution and versioning

- **One semver** across the whole framework. A release is a tag `vX.Y.Z`;
  CI builds and publishes every artifact for that tag together. One changelog,
  one release note.
- **Artifacts**:
  - JS framework → **npm** (`@less/bare`) — single package, subpath exports
    (`@less/bare/core`, `@less/bare/plugins`, `@less/bare/transports`,
    `@less/bare/runtime`). The package ships **compiled ESM JavaScript plus
    type declarations** (`dist/`, built with `vp pack` — tsdown) following the
    mantaq release flow; consumers never receive TypeScript source. A
    built-in runtime dependency on `@mantaq/core` powers the connection state
    machine (internal-only — never part of the exported surface).
  - Android host → **AAR, GitHub Packages** (Maven format, `io.less:bare-host`).
    The AAR is self-contained: Bare Kit runtime classes and native libs are
    bundled into the artifact at build time, so consumers need no prebuilds
    download.
  - iOS host → **source in `ios/`** (SPM package `BareHost`, depending on
    `bare-kit-swift`). Consumers embed `BareKit.xcframework` (prebuilds) plus
    the linked addons themselves; distribution is revisited when a consumer
    appears.
  - bare-kit prebuilds → **GitHub Release artifacts** (the pattern upstream
    `bare-kit` already uses), fetched by a documented script run by CI and on
    consumer setup. Prebuilds are never committed to this repository.
- The npm name `@less/bare` is approved but **not yet registered**. The first
  publish claims it; until then treat it as reserved in all docs and scripts.
- Release process is documented in `RELEASING.md` and executable by an AI agent
  with no human intervention beyond the tag decision.

## Public API stability contract

Breaking changes to the following are **major-version events**; everything else
in the repository is implementation and may change freely (layout, tooling,
internal module APIs, build scripts).

1. **Binary wire protocol** — frame layout and `version` byte (`core/messages`).
2. **Plugin manifest & event contracts** — `vendor.plugin` IDs,
   `DISPATCH`/`INVOKE_REQUEST`/`INVOKE_RESPONSE` semantics, event names and
   shapes, `Either` result tuples, deterministic error codes.
3. **JS exported surface** — the subpath exports of `@less/bare`.
4. **Kotlin host public API** — what Android consumers instantiate/subclass
   (bridge, coordinator, plugin registry).

Consequence: internal refactors (reorganizing files, switching tooling,
rewriting implementation) are **not** breaking changes and must not bump the
major version or be blocked by stability fears.

## Platforms and parity

| Runtime        | Status                         | Transport                                                                                                  |
| -------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Browser (dev)  | first-class                    | WebSocket                                                                                                  |
| Browser (test) | first-class                    | Mock (deterministic Playwright runs)                                                                       |
| Android        | first-class                    | WebSocket (same-origin loopback + cookie auth)                                                             |
| iOS            | first-class (reference parity) | WebSocket (same-origin loopback + cookie auth); host ships as source (`ios/`, SPM) on the same release tag |

Parity policy:

- Core protocol and plugin contracts are runtime-agnostic.
- Capabilities are opt-in plugins and may be runtime-specific.
- Plugins report unsupported behavior with deterministic errors.
- Feature code calls plugin events, never raw platform APIs, from shared UI
  code.
- iOS is at reference parity when the real native picker/camera and the Maestro
  journey set land (before beta); the platform table's status is that target.

## Toolchain

The project runs on **Vite+** (`vp`). It manages the Node runtime, package
manager, and toolchain in one place. The canonical commands are:

| Command      | Meaning                                                 |
| ------------ | ------------------------------------------------------- |
| `vp install` | Install dependencies                                    |
| `vp dev`     | Development server                                      |
| `vp check`   | Format (`oxfmt`) + lint (`oxlint`) + type-check (`tsc`) |
| `vp test`    | Tests (`vitest`)                                        |
| `vp build`   | Production build                                        |

These built-ins are the documented command surface — agent instructions and
`RELEASING.md` reference them, never ad-hoc `npm run <script>` chains unless a
`vp run` wrapper is defined. The project is fully migrated onto Vite+.

## Repository structure

- `core/`, `plugins/`, `web/transports` — sources of the single publishable
  package `@less/bare`.
- `examples/` — the reference app (web UI + Android app + iOS app), private
  workspace package, consumes the framework and is the integration harness.
- `e2e/` — Playwright specs against the reference app on the mock transport.
- `android/` — the Android host as a **library module** (`com.android.library`)
  so it can be built and published as an AAR; the example app consumes it.
- `ios/` — the iOS host as a **Swift package** (`BareHost`), mirroring the
  Android host; the iOS example app consumes it.
- `prebuilds/` — build output, gitignored, fetched from GitHub Release
  artifacts.

## Testing contract

Nothing ships without a green test gate:

- **Unit** — `vitest` for the protocol codec, plugin router, RPC messenger,
  and transports; **JUnit** for the Kotlin host (codec, IPC, registry).
- **Type check** — `tsc --noEmit` (part of `vp check`).
- **Integration** — Playwright e2e against the mock transport exercising the
  real binary protocol.
- **CI** — all of the above plus a Gradle build, green on every PR to `main`.

The unit gate is enforced mechanically — the Invariants below are part of the
test suite itself.

## Invariants

These are mechanically enforced by the test suite: `vp test --coverage` is red
when any breaks, so an agent knows exactly which claims it must keep true. The
presence manifest, public-API snapshot, and export-surface checks live in
`contract.test.ts`; the coverage floor lives in `vite.config.js`.

1. **Presence** — every framework-core module (`core/messages`, `core/lib`,
   `core/server`, `plugins/*`, `web/transports`) ships a co-located
   `*.test.ts`, barring an explicit exempt list (barrel `index.ts` files,
   generated bundles, entry points).
2. **Coverage floor** — no-regress statement/function/line thresholds over the
   covered framework core (`all: false`, `core/**` + `plugins/**` + `web/**`);
   branches are reported, not gated. Thresholds are anchored to day-one
   measured values and only get stricter.
3. **Public API snapshot** — the exported names of every `@less/bare` subpath
   are frozen; changing them is a major-version event.
4. **Export-surface integrity** — every `package.json` `exports` and `files`
   entry resolves to a real path.

Nothing else in this document is machine-checked; the Document set table is
prose and must be kept honest by review.

## AI autonomy operating principles

The repository is designed so that AI agents can carry out day-to-day
maintenance without a human in the loop:

1. **Read this document first.** It settles what belongs here and what does
   not.
2. **Follow `AGENTS.md`.** It is the operating manual: commands, conventions,
   ownership map, do/don't.
3. **Never commit build output.** Prebuilds, `*.gen.js`, web assets, and AARs
   are generated; artifacts are produced by CI on release tags.
4. **Respect the stability contract.** Refactor internals freely; gate breaking
   changes on the four public boundaries.
5. **Cut releases by the book.** `RELEASING.md` is the only release procedure;
   a release is a tag and CI does the rest.

## Document set

| Document           | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `vision.md`        | This file — what this project is and is not                |
| `AGENTS.md`        | AI operating manual (commands, conventions, ownership)     |
| `CONTEXT.md`       | Domain glossary for the framework's own development        |
| `docs/adr/`        | Architecture decision records                              |
| `rendering.md`     | lit-html + nanostores rendering rules (RootPart lifecycle) |
| `CONTRIBUTING.md`  | How to contribute (human + agent)                          |
| `RELEASING.md`     | The tag-driven release checklist                           |
| `ios-handoff.md`   | Historical brief for the superseded Phase 1 iOS design     |
| per-module readmes | `core/`, `plugins/`, transports, Android host              |
