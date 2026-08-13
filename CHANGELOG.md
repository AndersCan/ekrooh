# Changelog

All notable changes to `@ekrooh/bare` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Backend → web push** (`@ekrooh/bare/runtime`): `createLoopbackPush(server,
protocol)` + `LoopbackServer.push(frame)` — server-initiated dispatch to the
  connected web layer (live galleries, sync status).
- **Custom HTTP routes** (`@ekrooh/bare/runtime`): `LoopbackServer
.registerRoute(method, path, handler)` runs before mount resolution, behind
  the auth gate; `collectRequestBody` is re-exported for POST handlers.
- **Consumer plugins**: `createWorkletRuntime({ plugins: [...] })` registers
  consumer plugin manifests after the canonical defaults (no more post-hoc
  registry mutation).

### Fixed

- **`getIPC()` in plain Node**: no longer throws a `ReferenceError` when
  neither `BareKit` nor `Bare` is defined — returns `undefined`, so
  `createWorkletRuntime` runs host-less in tests/desktop contexts.
- **Dev mode with a storage dir** (`auth: false`): `handoff.json` is no longer
  written (previously a stale handoff appeared whenever `storage` was set,
  even with auth off).

## [0.1.0] - 2026-08-13

First stable release of the `@ekrooh/bare` framework (previously `@less/bare`),
published under the new name. Same feature set as `0.1.0-beta.1`, plus:

### Changed

- **Rebrand**: npm package renamed `@less/bare` → `@ekrooh/bare`; workspaces
  (`-e2e`, `-examples`, `-example-web`) and the Android AAR
  (`io.less:bare-host` → `io.ekrooh:bare-host`) follow. GitHub repo moved to
  `AndersCan/ekrooh`.
- **Token seam**: the shell now injects `window.__ekrooh = { token }` (an
  extensible bridge object) instead of `window.__lessBareToken`; the page
  reads `window.__ekrooh.token` for the `/login` cookie exchange.

## [0.1.0-beta.1] - 2026-08-12

First tagged release of the `@ekrooh/bare` framework: the boring bootstrap for
cross-platform apps on the Bare runtime. (An earlier `0.0.1` changelog draft
was never tagged — this entry absorbs it.)

### Added

- **Binary wire protocol** (`@ekrooh/bare/core`): framed envelopes
  (`version`, `type`, `headerLen`, JSON header, raw payload) with a canonical
  `MessageProtocol` codec, frame-size validation, and forward-compatible
  headers.
- **Plugin kernel**: namespaced plugin manifests, `DISPATCH` / `INVOKE_REQUEST`
  / `INVOKE_RESPONSE` routing, deterministic `ErrorCode`s, host delegation.
- **Typed plugin authoring**: `EventSpec` + `definePlugin` — one spec per event
  drives the manifest, the handler table, and the typed `events.ts` builders.
- **Unified loopback server** (`core/server/static-file-server.ts`) serves the
  web app at `/` (SPA fallback), mounted media, and the framed-protocol
  WebSocket socket; byte-range (206) streaming, WS origin check, single-client
  policy, idle timeout.
- **Cookie auth**: `POST /login` exchanges the injected `window.__ekrooh.token`
  for an `HttpOnly; SameSite=Lax` `bare_session` cookie; `X-Bare-Token`/`?token=`
  remain as fallbacks for non-browser clients.
- **Port/token handoff**: the worklet writes `handoff.json` into the host
  sandbox dir; hosts read it and load `http://127.0.0.1:<port>/index.html`.
- **Transports** (`@ekrooh/bare/transports`): WebSocket (same-origin default,
  cookie bootstrap, reconnect with backoff, token fallback on rejected
  upgrade) and a deterministic mock.
- **Android host** (`io.ekrooh:bare-host` on GitHub Packages): `BareProtocol`,
  `HostIpcCoordinator`, `HostPluginRegistry`; the Bare Kit runtime is packaged
  inside the self-contained AAR.
- **iOS host**: Swift package `BareHost` (SPM, ships as source) — IPC
  coordinator, plugin registry; the reference app injects the token via a
  `WKUserScript` and loads the loopback page.
- **Reference implementation**: `examples/web` (lit-html + nanostores),
  `examples/android-app`, `examples/ios-app`.
- **Testing contract**: vitest unit tests (with a coverage floor),
  JUnit (Kotlin host), XCTest (Swift host), Playwright e2e against the mock
  transport, and CI (`test.yml`, `playwright.yml`, `release.yml`).
- **WS connection state machine**: the WebSocket transport models
  idle/opening/connected/backoff/gaveUp as a mantaq `Actor` (exponential
  backoff, retry cap, `?token=` fallback) — internal-only, never leaks into
  the public surface.
- **Multi-instance web test harness**: a dev harness (`harness.core`) hosting
  N worklet instances behind a management server, with Playwright journeys
  (one tab per instance) asserting per-instance isolation + lifecycle.
- **iOS reference parity**: real `vendor.media` picker/camera
  (`PHPickerViewController` + `UIImagePickerController`; simulator answers a
  deterministic "camera unavailable") and a generic permissions plugin
  (`permissions.request` / `permissions.status`) with real
  `AVCaptureDevice.requestAccess` for camera.
- **iOS p2p addons**: udx-native, rocksdb-native, sodium-native (+ hypercore's
  quickbit/rabin/simdle and fs-native-extensions) linked via bare-link and
  verified running on the iOS simulator (`P2PVerifyTest` boots a worklet that
  exercises Corestore, Hyperdrive, and Hyperswarm).

### Changed

- **npm ships compiled JS**: `@ekrooh/bare` publishes `dist/` (compiled ESM +
  type declarations via `vp pack`) — consumers never receive TypeScript source.
- **Permissions plugin contract**: `permissions.requestStorage` is replaced by
  `permissions.request(permission)` / `permissions.status(permission)`,
  both returning `{ permission, status }`
  (granted | denied | notDetermined | unsupported).

### Fixed

- **WS auth fallback**: a WebSocket upgrade rejected despite a successful
  `/login` now retries with `?token=` appended instead of retrying the same
  URL five times and dead-ending.
- **`/login` body decoding**: `Uint8Array` chunks (bare-http1) are decoded
  byte-exact instead of being `String()`-ified (which joined bytes with commas).
- **Single-client WS policy**: the refused second socket is rejected before the
  handshake — no misleading 101-then-close.
- **serveFile stream errors**: an evicted file (spool LRU) no longer crashes
  the whole worklet — pre-flush ENOENT yields a clean 404 and a mid-stream
  error resets the response instead of surfacing an unhandled stream error.

### Removed

- Android bootstrap bridge and iOS WKWebView bridge transports; the
  `BarePortMessenger`, `BareWebViewBridge`, and `BareAssetSchemeHandler`
  relays were deleted.
