# Changelog

All notable changes to `@less/bare` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed (Phase 2 — unified loopback server + cookie auth)

- **One loopback server** (`core/server/static-file-server.ts`) now serves the
  web app at `/` (SPA fallback), the media files, and the framed-protocol
  WebSocket socket; the standalone dev WS server is gone.
- **Cookie auth** replaces the URL token: `POST /login` exchanges the injected
  `window.__lessBareToken` for an `HttpOnly; SameSite=Lax` `bare_session`
  cookie that rides media loads and the WS upgrade. `X-Bare-Token`/`?token=`
  remain as a fallback for non-browser clients.
- **Port/token handoff**: the worklet writes `handoff.json` into the sandbox
  dir the host passes (also set as `Worklet.Configuration.assets`); hosts read
  it and load `http://127.0.0.1:<port>/index.html`.
- **Transports**: `createWebSocketTransport` defaults to the page origin,
  bootstraps the cookie when a token is present, and reconnects with backoff
  (250ms→2s, 5 tries). The Android bootstrap bridge and iOS WKWebView bridge
  transports were **removed** (`@less/bare/transports` now exports WebSocket +
  mock only).
- **Hosts**: Android `MainActivity` copies APK web assets out (bare-fs cannot
  read them), injects the token, and loads the loopback page; iOS `BareRuntime`
  serves the bundled `WebAssets` and injects the token via a `WKUserScript`.
  `BarePortMessenger`, `BareWebViewBridge`, `BareAssetSchemeHandler`, and the
  WebView relays were deleted.
- **Streaming**: the static server streams via `createReadStream` + `pipe`
  with `Range`/206 support instead of whole-file reads.
- **Server hardening**: origin check on WS upgrade, single-client policy, idle
  timeout.

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
