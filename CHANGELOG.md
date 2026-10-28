# Changelog

All notable changes to `@ekrooh/bare` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-10-28

### Security

- **Per-port session cookie**: the session cookie is now `bare_session_<port>`
  (was `bare_session`). Cookies are scoped to the host, not the port, so two
  loopback servers sharing one cookie store overwrote each other's session.
- **No session token in `handoff.json`**: the file now holds
  `{ origin, port, bootstrap }`. A host that read `token` from it gets it from
  `runtime.start()` inside the worklet instead.
- **Gated directory mounts are sandboxed**: files served from a `mountDir`
  without `{ public: true }` now carry the same `sandbox` Content-Security-Policy
  as file mounts. An HTML or SVG file in a mounted folder (for example one a
  peer synced) could previously run script in the app origin and drive every
  plugin. **Breaking** for a consumer that served app code from a gated mount:
  move it to the public mount.
- **No unauthenticated non-loopback bind**: `createLoopbackServer` (and so
  `createWorkletRuntime`, CLI `host=`) throws when `host` is not a loopback
  address and auth is off. The Host/Origin rule only stops browsers, so
  `mode=dev host=0.0.0.0` exposed every plugin to the network.
- **Host calls use their own request ids**: the host IPC bridge no longer
  reuses the page-supplied `requestId` on the host channel, so a page cannot
  supersede or cross-wire other pending host calls.
- **`vendor.media` validates `kind`**: values other than `image`/`video` are
  refused before reaching the host or the mount path.
- **Bounded log ingest**: `POST /logs` truncates messages to 8 KiB and tags to
  64 chars, and `GET /logs` (text) escapes line breaks so a page entry cannot
  pose as a backend line.
- **Android navigation confinement** (`BareWebViewClient`): new
  `allowedOrigin`; main-frame navigations off the loopback origin are cancelled
  and http(s) links open in the system browser, matching iOS. The reference app
  sets it and disables WebView file and content access.
- **Dev harness**: the supervisor no longer sends `Access-Control-Allow-Origin: *`
  and refuses requests with an `Origin` or a foreign `Host`, so a website can no
  longer read instance credentials from it.
- **Supply chain**: the release job installs dependencies with
  `--ignore-scripts` (esbuild rebuilt explicitly) while it holds the npm OIDC
  token, and `fetch-prebuilds` refuses to unpack without a real lockfile hash.
- **Security model**: `docs/security.md` (threat model and review checklist),
  `SECURITY.md`, the `security-review` agent skill, and `security.test.ts`
  guarding greppable invariants.

- **Origin rule in every mode** (`core/server/loopback-gate.ts`): with auth
  off (the dev backend), the loopback server no longer accepts any `Host` or
  page `Origin`. A website open in the same browser could previously open the
  dev protocol socket (WebSocket upgrades bypass CORS) and invoke every plugin.
  Cross-origin dev pages must be listed in `allowedOrigins` (CLI `origin=`).
- **Secure defaults** (`@ekrooh/bare/runtime`): `createWorkletRuntime`
  defaults to device mode (auth on, ephemeral port) whether or not `storage` is
  set, and `resolveCliConfig` keeps those defaults unless `mode=dev` is passed
  (`auth=off` without `mode=dev` is ignored with a warning).
  The desktop sidecar forces auth on. A broken host configuration no longer
  falls back to an unauthenticated dev server.
- **Nonce-only login**: `POST /login` no longer accepts the raw session token,
  and the web transport no longer reads `window.__ekrooh.token`.
- **Path containment**: path segments are percent-decoded and rejected (400)
  when they decode to `.`, `..`, a separator or NUL; a directory mount never
  serves a file whose real path (symlinks resolved) is outside its root.
- **No error detail in responses**: a throwing route or handler answers a bare
  `500 Internal Server Error`; the cause goes to the log.
- **Tighter headers**: the session cookie is `SameSite=Strict`; HTML
  `connect-src` names the one protocol socket instead of any `ws:` host, and
  the policy adds `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`
  and `frame-ancestors 'none'`. Mounted session files (media) are served with a
  sandboxing CSP so a hostile file opened as a document cannot run script at
  the app origin. Every file response sends `X-Content-Type-Options: nosniff`.
- **Protocol socket**: an `error` on the WebSocket (a peer reset) is contained
  even when no connection handler listens, instead of crashing the worklet;
  inbound messages are capped at the protocol's 16 MiB frame size.
- **Log ingest**: `POST /logs` records every entry as `source: 'web'` and
  validates `level`/`tag`; a non-object body or a malformed `GET /logs` query
  is a 400, and only an oversized body is reported as 413.
- **Mount paths** are normalized like request paths (`/media/a%20b/` and
  `/media/a b` name one mount); a mount path no request could match throws.

### Changed

- **BREAKING:** dev mode is opt-in (`deviceMode: false` or `mode=dev`); see
  [ADR 0006](docs/adr/0006-secure-by-default-loopback.md). Dev runners pass
  `mode=dev` and the Vite dev origin; the example Vite servers are pinned to
  port 5173.
- **BREAKING:** `getIPC()` returns `null` when there is no host (it returned
  `undefined` typed as the channel).
- **BREAKING:** `handoff.json` no longer carries `token`, and the session
  cookie is named `bare_session_<port>` (see Security).
- A protocol socket upgrade inside the replacement interval
  (`wsReplaceMinIntervalMs`) is held until the interval passes instead of being
  dropped, so a quick reconnect no longer costs the page one of its 5 retries.
  A refused upgrade is answered with its HTTP status (401, 403, or 429 for a
  held upgrade superseded by a newer one) instead of a bare connection close.
- The loopback server is split into the loopback gate (admission), the
  protocol socket slot (`core/server/protocol-socket.ts`) and the HTTP serving
  that remains in `static-file-server.ts`. The host IPC and the WebSocket share
  one frame channel (`core/messages/frame-channel.ts`) for reassembly, routing
  and malformed-frame policy.
- `createWorkletRuntime` builds its protocol, registry and router through
  `createBareRuntimeContext`, which now allocates one text encoder/decoder per
  context instead of one per frame.

### Added

- `allowedOrigins` on `LoopbackServerOptions` and `WorkletRuntimeOptions`, and
  the `mode=` and repeatable `origin=` CLI tokens.

### Removed

- The unused mantaq messenger prototype (`rpc-messenger.mantaq.ts`,
  `pending-call.ts`) and the `@mantaq/sugar` dependency.

## [0.5.0] - 2026-10-26

### Added

- **Linux desktop reference app** (`examples/desktop-app`): same Zig host and
  sidecar `bare` as macOS, on GTK/WebKitGTK 4.1, packaged by
  `npm run build:desktop` as `ekrooh-linux-<arch>.tar.gz` with a `.sha256`.
  Verified in CI only (`desktop-linux`).

### Changed

- **Backpressure in both directions** (`core/messages/backpressure.ts`,
  `core/server/static-file-server.ts`, `core/server/websocket-server.ts`):
  - Writes to the protocol socket honour `write() === false` through one
    bounded queue (`wsMaxQueuedBytes`, default 2 MiB). When the client stops
    reading, server pushes past the limit are dropped **newest first** and
    counted in `core.logs`; `push()` returns false for a dropped frame. A
    response is never dropped: it queues up to 8x the limit, then the socket is
    closed so the client reconnects.
  - The protocol socket stops being read while 32 routed calls are pending and
    resumes at 16. The host IPC channel is not paused (a pending host call
    waits for responses on that same stream).
- **Reconnect, heartbeat and socket replacement** (`core/server/static-file-server.ts`,
  `web/connection-machine.ts`, `web/websocket-client.ts`):
  - The protocol socket now has a protocol-level ping/pong dead-peer timeout
    (`wsDeadPeerTimeoutMs`, default 10s; `bare-ws` `idleTimeout`, needs
    `bare-ws` >= 3.1.0). No wire-protocol change; browsers answer pings
    themselves.
  - A new client that passes the same origin and auth checks **replaces** the
    current protocol socket instead of being refused, so a reloaded or
    suspended WebView no longer holds the slot. At most one socket is live at
    any time; replacement is rate-limited (`wsReplaceMinIntervalMs`, default 1s).
  - The web client keeps reconnecting without a retry limit once it has
    connected (capped backoff), retries immediately when the app returns to
    the foreground, and fails requests fast during a long outage. Before the
    first connect the retry cap and terminal `gaveUp` are unchanged.

- **Loopback auth surface tightened** (`core/server/static-file-server.ts`,
  `core/runtime.ts`, reference hosts — ADR `docs/adr/0003-loopback-auth-surface.md`):
  - The `?token=` query-param auth path is **removed**; `isAuthorized` accepts
    only the `bare_session` cookie nonce or the `X-Bare-Token` header. The raw
    token is never placed in a URL.
  - The page receives only a **single-use bootstrap nonce** via
    `window.__ekrooh.bootstrap` (exchanged for the cookie via `POST /login`),
    never the raw token. `handoff.json` now carries `{ origin, port, token,
    bootstrap }`; the host keeps `token` for itself and injects only
    `bootstrap`.
  - Directory mounts are **gated by default**; `mountDir(..., { public: true })`
    opts into world-readable bootstrap serving (the web app at `/`). The SPA
    fallback applies only to public mounts.

[0.4.0] - 2026-08-16

### Added

- **macOS desktop reference app** (`examples/desktop-app`, `core/desktop.core.ts`):
  a Zig host with the system webview and a sidecar `bare` backend, built by
  `npm run build:desktop` and smoke-tested in CI (`desktop` job). The backend
  hands its origin and bootstrap nonce to the host over a private pipe, so no
  credentials are written to disk. One instance per storage dir (a second
  launch is a no-op), and startup failures or a crashed backend show an error
  page instead of a silent exit.
- **`handoffFile` runtime option** (`createWorkletRuntime`): set `false` to
  keep the credentials out of `<storage>/handoff.json` when the host receives
  them another way. Defaults to `true`, so existing hosts are unaffected.

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
