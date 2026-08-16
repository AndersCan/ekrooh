# Changelog

All notable changes to `@ekrooh/bare` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Peer-drive replication in the on-device p2p verify worklet** (`core/
p2p-verify.core.ts`, issue #41): the worklet now replicates a drive across
  two real peers over the local DHT — a creator announces its drive and
  serves it; a reader joins the topic client-only, opens the drive by key,
  `ready()`s it (the call the Android photo app timed out on), and reads a
  photo. This is the platform-level reproduction gate for "Android cannot
  replicate a peer's drive": green on a runtime proves it can do peer reads.
- **Android emulator p2p verify** (`examples/android-app`): the reference app
  packs `core/p2p-verify.core.ts` as `p2p-verify.bundle` and ships a
  `P2PVerifyTest` instrumentation test + a new `android-emulator` CI job. The
  Android gate runs the worklet in `mode=self` (corestore/hyperdrive
  self-reads — the "reverse direction" that always worked on Android per
  #41), because real DHT peer discovery is unreliable under the
  software-rendered x86_64 CI emulator; the full peer-drive replication gate
  runs on the macOS smoke (`npm run smoke:p2p`) and the iOS simulator.
  Verified locally: full peer-drive `308ms` on an Android emulator — the
  framework stack handles peer-drive reads on Android bare-kit, pointing the
  #41 timeout at the consumer's wiring rather than the runtime.

### Fixed

- **bare-host POM drops `api` dependencies** (`android/build.gradle`, issue
  #36): the published AAR's POM carried no `<dependencies>` because the
  publication attached the AAR artifact directly instead of the AGP `release`
  component. Consumers compiling against `io.github.anderscan.ekrooh:bare-host`
  failed on `WebViewCompat`/appcompat. The publication now uses
  `from components.release`, so the POM carries the `api` deps; CI asserts it.
- **Reference hosts pass the full worklet argv** (`examples/android-app`,
  `examples/ios-app`, issue #39): both shells now start the worklet with the
  three-dir contract `[webAssets, storage, cache]`, silencing the
  `cache dir missing or not a directory` fallback warning on every boot.
- **Android example build works at any module depth** (`examples/android-app/
build.gradle`, issue #38): the JS `Exec` tasks use the Gradle root project
  (overridable via `-Pekrooh.repoDir=<dir>`) instead of a hardcoded `"../../"`
  working dir, and write outputs under the module's own dir.
- **`link` task fails on an empty link set** (`examples/android-app/
build.gradle`, issue #37): bare-link exiting 0 while linking nothing (pnpm
  isolated node_modules, or a monorepo root without direct native-addon deps)
  now fails the build with an actionable message instead of shipping an APK
  that aborts with `dlopen failed`.

### Docs

- **On-device argv contract** documented in `apps/docs` (consumers/
  worklet-entry + host-handoff): `[webAssets, storage, cache]` order, the
  cache-dir fallback warning, and the labeled CLI tokens.
- **New consumer guide** `consumers/android-host-build`: repo-root working dir,
  flat-node_modules requirement (pnpm `nodeLinker=hoisted`), passing the entry
  package to `bare-link`, and the empty-link-set guard.

## [0.3.0] - 2026-08-16

### Added

- **Android host on Maven Central**: `io.github.anderscan.ekrooh:bare-host`
  now publishes (PGP-signed, sources + javadoc included) to Maven Central
  via the Sonatype Central Portal on the same tag as the npm package —
  no consumer credentials. GitHub Packages remains as a fallback.
- **CLI config tokens** (`@ekrooh/bare/runtime`): `resolveCliConfig()` parses
  labeled `bare` CLI arguments (`webassets=`, `storage=`, `cache=`, `port=`,
  `host=`, `auth=`); `resolveWorkletConfig()` falls back to it, so one worklet
  entry serves both on-device and CLI runs.
- **Consumer example** (`examples/consumer-basic`): minimal runnable consumer
  with its own worklet entry, an `app.basic` plugin (one invoke + one
  backend → web push), the web layer, and a real-stack e2e
  (`npm run test:e2e:consumer`).

### Changed

- **Pending-call handler** (`core/messages`): the per-request handler owns its
  outcome and emits a declared `SETTLED` output (`answered` | `timedOut`);
  the messenger re-emits `DONE` and settles a shell-side promise map — no
  promise lives in the machine, and a handler that dies into `__error`
  rejects instead of hanging.
- **`deviceMode` override**: `createWorkletRuntime({ deviceMode: false })`
  keeps dev semantics (auth off, fixed port) even with a `storage` dir.

### Fixed

- **p2p smoke determinism** (`core/p2p-verify.core.ts`): the dev verify
  worklet now performs a real connect + Noise handshake against an ephemeral
  loopback DHT bootstrapper, immune to stale bootstrap records from earlier
  killed runs (issue #28).

## [0.2.0] - 2026-08-13

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
