# Ekrooh - Technical Vision

> Companion to `vision.md` (the concise repo briefing). This file holds the
> technical depth: runtime model, protocol, distribution, and the integration
> points justus depends on. Read this when implementing, not when prioritizing.

## Architecture in one paragraph

Ekrooh is the cross-platform bootstrap for apps on the **Bare** runtime (the
holepunch platform). It owns the boring plumbing: a binary wire protocol,
namespaced plugin contracts, transports (WebSocket for real, mock for
deterministic tests), and native hosts (Android AAR, iOS Swift package) that
load a web worklet and bridge it to the device. It is a framework, not a
product - consumers (justus) build features as their own plugins on top.

## Why this shape

- **Bare runtime:** on-device execution is a worklet, not Node. Node only runs
  the dev backend. The framework must therefore be runtime-agnostic at its core
  and platform-specific only at the host boundary.
- **Protocol-first:** a frozen binary wire protocol (`core/messages`) is the
  stable contract between web and native; internal refactors never touch it.
- **Plugin model:** capabilities (camera, BLE, storage, p2p) are opt-in plugins
  reporting deterministic errors when unsupported - keeps the core small and the
  surface stable.

## The p2p layer (what justus needs)

- Ekrooh enables p2p by providing the transport and host IPC; it is **not**
  itself a P2P framework (not Pears). The peer-to-peer behavior lives in
  consumer plugins built on Ekrooh's transports.
- justus's "no servers" promise is realized at this boundary: Ekrooh must give
  justus a direct peer transport with no mandatory central relay.
- Key integration point: the connection state machine is internal **Mantaq**,
  so justus can react to connect/disconnect deterministically.

## Distribution and versioning (technical)

- One semver across the whole framework; a tag `vX.Y.Z` builds and publishes
  every artifact together (one changelog).
- Artifacts: npm `@ekrooh/bare` (compiled ESM + types, subpath exports),
  Android `io.ekrooh:bare-host` AAR (self-contained, bundled runtime), iOS
  `BareHost` Swift package (git-fetchable on the tag, bundled xcframework).
- Published as compiled JS, never TypeScript source; `@mantaq/core` is an
  internal (non-exported) dependency for the connection machine.

## Rendering stack for consumers

Ekrooh governs rendering via `rendering.md` (lit-html + nanostores, RootPart
lifecycle). The recommended consumer stack - which justus follows - is
`lit-html` (library only, not the full Lit framework) for templating and
`unocss` for utility-first CSS. Feature code calls plugin events, never raw
platform APIs, so this UI stack stays portable across web/Android/iOS.

## Platform parity

- Browser (dev + deterministic mock test) and Android are first-class.
- iOS targets reference parity (real native picker/camera + Maestro journeys)
  before beta - the host ships as a git-fetchable package on the same tag.
- Feature code calls plugin events, never raw platform APIs, so shared UI stays
  portable.

## Stability contract (machine-checked)

Breaking changes are gated to exactly four boundaries: wire protocol, plugin
manifest/event contracts, JS exported surface, Kotlin host public API. Internal
layout, tooling, and implementation may change freely. The test suite enforces
presence, coverage floor, public-API snapshot, and export-surface integrity.

## Open technical questions

- Shared, tag-driven release of three artifact types with zero human steps
  beyond the tag decision.
- iOS parity depth: how much native capability must match Android before beta.
- Determinism of the mock transport across the full justus p2p journey.
