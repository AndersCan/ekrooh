# Ekrooh - Technical Vision

Companion to [`vision.md`](vision.md). Read when implementing, not when prioritizing.

## Shape

- **Bare runtime.** On-device code runs as a worklet, not Node. Node runs only
  the dev backend. The core is runtime-agnostic; platform code lives only at the
  host boundary.
- **Protocol-first.** The binary wire protocol (`core/messages`) is the stable
  contract between web and native. Internal refactors never touch it.
- **Plugins.** Capabilities (camera, BLE, storage, p2p) are opt-in plugins that
  report deterministic errors when unsupported. This keeps the core small and the
  surface stable.
- **Hosts.** Android (AAR, bundled runtime) and iOS (`BareHost` Swift package,
  bundled xcframework) load the web worklet and bridge it to the device.

## p2p layer (what justus needs)

- Ekrooh provides the transport and host IPC. It is **not** a P2P framework
  (not Pears). Peer behavior lives in consumer plugins on Ekrooh's transports.
- justus's "no servers" promise is realized here: Ekrooh must offer a direct
  peer transport with no mandatory central relay.
- The connection state machine is internal **Mantaq**, so justus can react to
  connect and disconnect deterministically.

## Rendering stack for consumers

Rendering rules are in [`rendering.md`](rendering.md). The recommended consumer
stack, which justus follows, is `lit-html` (library only) for templating and
`unocss` for CSS. Feature code calls plugin events, never raw platform APIs, so
the UI stays portable across web, Android, and iOS.

## Distribution

Artifacts, one semver per tag: npm `@ekrooh/bare`, Android
`io.github.anderscan.ekrooh:bare-host` (AAR), iOS `BareHost` (git-fetchable on the tag).
Release steps are in [`RELEASING.md`](RELEASING.md). Stability boundaries are in
[`vision.md`](vision.md#stability-contract).

## Open questions

- Shared, tag-driven release of the three artifact types with no human steps
  beyond the tag decision.
- iOS parity depth: how much native capability must match Android before beta.
- Determinism of the mock transport across the full justus p2p journey.
