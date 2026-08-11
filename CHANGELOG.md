# Changelog

All notable changes to `@less/bare` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.1] - 2026-08-09

First release of the `@less/bare` framework: the boring bootstrap for
cross-platform apps on the Bare runtime.

### Added

- **Binary wire protocol** (`@less/bare/core`): framed envelopes
  (`version`, `type`, `headerLen`, JSON header, raw payload) with a canonical
  `MessageProtocol` codec, frame-size validation, and forward-compatible
  headers.
- **Plugin kernel**: namespaced plugin manifests, `DISPATCH` / `INVOKE_REQUEST`
  / `INVOKE_RESPONSE` routing, deterministic `ErrorCode`s, host delegation.
- **Typed plugin authoring**: `EventSpec` + `definePlugin` — one spec per event
  drives the manifest, the handler table, and the typed `events.ts` builders.
- **Transports** (`@less/bare/transports`): WebSocket (dev), deterministic mock
  (tests), and the Android bootstrap bridge over a `WebMessagePort` carrying raw
  frames.
- **Android host** (`io.less:bare-host` on GitHub Packages): `BareProtocol`,
  `HostIpcCoordinator`, `HostPluginRegistry`, `BarePortMessenger`, and the
  packaged Bare Kit runtime (classes + native libs) inside the AAR.
- **Reference implementation**: `examples/web` (lit-html + nanostores) and
  `examples/android-app` demonstrating every canonical plugin
  (`core.health`, `core.discovery`, `core.permissions`).
- **Testing contract**: unit tests (`vitest`, JUnit), Playwright e2e against
  the mock transport, and CI (`test.yml`, `playwright.yml`, `release.yml`).
