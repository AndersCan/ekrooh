# Changelog

All notable changes to `@ekrooh/bare` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `createWebSocketTransport` returns an optional `ready()` that resolves once the socket is open, or the transport gave up, closed or was replaced. Await it before the first call so the invoke deadline measures the round trip, not the connect.

## [0.7.0] - 2026-11-08

This release changes behaviour at stability-contract
boundaries (plugin id rules, error codes and messages, `FRAME_INVALID`
handling, option meanings, Kotlin host behaviour), and in 0.x a breaking change
bumps the minor version (as ADR 0006 did with 0.6.0).

Security and correctness fixes from the November 2026 review. No export was
removed and the wire `VERSION` is still `1`, but several defaults and error
paths changed. **Entries marked "Can break" can break a consumer that relied on
the old behaviour**; read them before upgrading.

### Security

- **Can break — `createWorkletRuntime({ auth: false })` throws** unless
  `deviceMode: false` is also set. Before, it silently ran device mode without
  auth.
- **Can break — Fetch-metadata gate**: with auth on, a gated request or
  WebSocket upgrade carrying `Sec-Fetch-Site: same-site` or `cross-site` is
  refused with 403. Session cookies are not port-isolated, so a page on another
  `127.0.0.1` port could otherwise load gated files with our cookie. Requests
  without the header (non-browser clients) are unchanged, and a request whose
  `Origin` is exactly an `allowedOrigins` entry is exempt.
- **Can break — bootstrap nonce TTL**: an unredeemed nonce expires after 120 s
  (`BOOTSTRAP_TTL_MS`) of running time counted from the first page request
  (a `/login` before any page load is accepted only inside the 600 s unloaded
  window); the clock pauses while the Bare
  worklet is suspended. A nonce whose page never loads expires after 600 s of
  running time (`BOOTSTRAP_UNLOADED_TTL_MS`).
  `LoopbackServerOptions.bootstrapTtlMs` overrides the 120 s (an invalid value
  falls back to it; capped at 600 s, `BOOTSTRAP_TTL_MAX_MS`). A `/login` after
  expiry is a 401; an existing session cookie keeps working.
- **Can break — `mountDir` overlap throws**: a gated directory mount whose root
  is inside or equal to the public root is refused, in either mount order
  (real paths; case- and normalization-insensitive only on macOS, iOS and
  Windows, `foldPathCase` overrides). A gated root strictly around the public
  one is allowed. The public mount 404s files inside a gated root.
- **Can break — `registerRoute` paths are normalized** like mount paths
  (decoded, trailing slash dropped); a path no request could match throws.
- **Can break — generic error messages** (error text is part of the plugin
  contract): a plugin or host handler that throws
  is answered with a fixed message (`<pluginId>.<event> failed`); the detail is
  logged. Return `err(code, message)` to send a specific message. Host error
  codes outside the canonical set or the app-scoped form (`ns.x/code`, ≤ 64
  chars) become `HOST_ERROR`; host messages are capped at 512 chars (`vendor.media`: 500; it passes app-scoped host codes such as
  `app.media/cancelled` through). Oversized-response fallbacks no longer echo the
  plugin, event or reason.
- **Can break — plugin id format and reserved namespaces**: `register` rejects
  an id that is not two or more dot-separated `[A-Za-z0-9_-]` segments (≤ 256
  UTF-8 bytes), and any `core.*`/`vendor.*` id other than the framework's own
  plugins. Rename consumer plugins to your own namespace (`app.photos`).
- **Can break — `FRAME_INVALID` behaviour**: `pluginId`/`event`/`requestId`
  over 256 UTF-8 bytes and invalid UTF-8 in a header (was U+FFFD) are
  `FRAME_INVALID`. A content-invalid frame is skipped and answered
  `FRAME_INVALID` instead of closing the protocol socket; on the host IPC a bad
  host response fails its call at once and no longer drops the good frames
  coalesced with it. iOS and Android answer malformed IPC fields with
  `FRAME_INVALID` too.
- **Can break — iOS storage moved**: the reference app and
  `BareStorage.prepare()` keep storage in `Application Support/bare` (was
  `Documents/bare`, moved once on first launch) and the cache in
  `Caches/bare-cache`. Storage exclusion from backup is fatal if it fails.
- **Can break — Android storage moved**: the reference app keeps durable
  storage in `noBackupFilesDir/bare` (was `cacheDir/bare`, where "Clear cache"
  wiped the p2p identity), moved once on upgrade. Backup and device-transfer
  rules now exclude every domain, `root` and `device_*` included.
- **Can break — iOS permissions fail closed**: a missing or unknown permission
  id is `unsupported` (was answered as `storage`, i.e. `granted`).
- Constant-time credential comparison, the 1024 pending-host-call cap and the
  forged-`HOST_*_RESPONSE` rule are now pinned by tests.
- Files are served from a verified descriptor (real path + `dev`/`ino`
  re-checked after open), so a symlink swapped in after the check is refused;
  an unreadable file-mount target is a 404.
- Responses from routes and the framework send `nosniff`, and, with auth on, gated
  responses send `Cross-Origin-Resource-Policy: same-origin` (also when
  `allowedOrigins` is set; off in dev). A route that fails after its response
  ended is only logged, and a route's 500 drops the headers the handler set. An oversized `/login` body is a 413 and closes the connection.
- Upgrade-rejection logs are rate limited (10 per 10 s) and truncated to 200
  chars; captured backend console messages are capped at 16 KiB; `logs.view`
  rejects a non-number `tail` and unknown `level`/`source`, and `LogStore.view`
  returns nothing for an invalid `tail` (was everything).
- `handoff.json` is written atomically with mode `0600`.
- **Android host**: `BareWebViewClient` also blocks off-origin POST
  navigations (empty 403), opens external links only on a user gesture,
  refuses userinfo URLs; the reference app declares `CAMERA`, runs the
  worklet once per process in the `Application` (`singleTop` activity that
  survives UI-mode, density, font-scale, locale and layout-direction changes;
  later WebViews get no nonce; a late handoff is still loaded; a failed
  storage migration falls back and is retried), feature-checks
  `addDocumentStartJavaScript`, reads the handoff through `BareHandoff` (never
  logged), and keeps the p2p verify bundle out of the APK.
  `requireSupportedAbi()` also throws in a 32-bit process.
- **iOS host**: confinement, bootstrap injection, handoff deletion and backup
  exclusion move into `BareHost` (`BareNavigationDelegate`, `BareWebHost`,
  `BareHandoff`, `BareStorage`); a non-JSON handler result is
  `INVALID_RESPONSE` instead of a crash. A same-origin `target=_blank` loads
  in place; a failed `Documents/bare` migration is retried next launch; the
  asset cache moves to `Caches/bare-cache/asset-cache`.
- **Can break — iOS host timeouts**: `HostPluginRegistry.register` traps
  (precondition) on a non-positive or NaN timeout; timeouts are clamped to
  `maxInvokeTimeout` (one day).
- **Desktop**: the window is confined to the backend origin, external links
  open in the system browser, clipboard read is off, and the
  `EKROOH_TEST_HANDOFF_COPY` hook exists only in `-Dtest-hooks=true` builds.
- **Dev harness**: the supervisor refuses a non-loopback bind, caps live
  instances at 32 (429), cleans up a failed allocation and answers a 500 with
  no detail.
- **Release pipeline**: `release.yml` is split into a credential-free
  `build` job (checks the tag equals the version and is on `main`, then runs
  `build:pkg`, `docs:check`, `vp check`, `vp test` and the Gradle build), an
  OIDC-only `publish-npm` job that publishes the packed tarball with no
  checkout or install, and a `publish-maven` job that runs only the Gradle
  publish tasks. Gradle dependency verification is on. `publish-npm` fails
  early on npm older than 11.5.1. The OSV vuln scan ignores the Maven
  ecosystem (its only input is the Gradle build-tool hash list); npm lockfiles
  are still scanned. The docs-only classifier is rename-aware, and install
  detection in `security.test.ts` is segment-aware (gems included). Workflow-level
  permissions are read-only, every checkout drops its token, and
  `CODEOWNERS` covers the trust boundaries.
- **Maven publishing runs no Gradle next to the secrets**: the Gradle builds
  no longer sign or upload (the `signing` and Nexus publish plugins are gone).
  The credential-free build job stages the unsigned publication with
  `publishMavenAarPublicationToLocalStagingRepository`; the publish jobs in
  `release.yml` and `release-bare-kit-runtime.yml` sign it with `gpg` and
  upload it with `curl` (`.github/scripts/publish-maven.sh`, Central Portal
  publisher API). CI dry-runs the signing path with a throwaway key.
- **Merge queue ready**: the workflows holding required checks also run on
  `merge_group`.
- **Can break — `npm run prebuilds`** no longer needs `gh` or a token (it
  fetches the public release URL), replaces `prebuilds/android` and
  `prebuilds/ios` wholesale, refuses absolute, `..` and symlink archive
  entries, and a version argument must equal the lockfile's.
- **Can break — deploy templates**: `DEPLOY_APPROVERS` is removed (it gated
  nothing). The templates need the environments `android-signing`,
  `internal`, `production`, `ios-signing`, `testflight`, each limited to the
  default branch and holding its own secrets.

### Changed

- **The Bare Kit runtime is a separate Android artifact** ([ADR 0007](docs/adr/0007-separate-bare-kit-runtime-artifact.md)):
  `bare-host` no longer bundles `libbare-kit.so` and the Bare Kit `classes.jar`.
  It depends on `io.github.anderscan.ekrooh:bare-kit-runtime:2.5.5` instead,
  which Gradle resolves from Maven Central automatically. The `bare-host` AAR
  goes from about 69 MB to about 40 KB. The runtime is published only when
  bare-kit is bumped, because Maven Central limits monthly release size. No
  consumer changes are needed.
- **Can break — host timeouts**: a host call that misses its deadline is
  `TIMEOUT` (was `HOST_ERROR`). Event deadlines now reach the host bridge: `vendor.media`
  waits 4 min 55 s and `permissions.request` 5 min (was a fixed 30 s, which
  dropped a photo picked after 30 s). iOS and Android hosts honour per-handler
  timeouts.
- **Web transport reconnect**: sent invokes fail with `TRANSPORT_ERROR` as soon
  as the socket is lost (they waited out their timeout). Retries use equal
  jitter; a never-connected client gives up only after 5 retries **and** 10 s;
  the retry count resets after 5 s of stable open; a socket stuck connecting is
  dropped after 10 s; `WAKE` recovers a client that gave up. A socket the
  server replaced is closed with code 4001 `"replaced"`, and the client waits
  30 s or a foreground before reconnecting, so two documents no longer evict
  each other forever. At most 256 requests queue while connecting.
- Give-up and invoke-timeout errors no longer include server log lines unless
  `diagnostics: true` is set.
- **Can break — per-channel cap**: the router caps calls per channel (48 of
  64, `maxInflightPerChannel`); over it is `TRANSPORT_ERROR`. A per-plugin cap
  (`maxInflightPerPlugin`) is available but off by default. Ids are capped at
  256 UTF-8 bytes; an undecodable host capabilities answer fails the query
  with `FRAME_INVALID`; timer delays are capped at 2^31−1 ms.
- **Can break**: a declared event with no handler is `UNSUPPORTED_EVENT` (was
  `PLUGIN_ERROR`).
- A route handler that rejects is answered with a 500 (it used to abort the
  worklet).
- **Can break — `runtime.start()` rejects** when the handoff cannot be
  written, when `mountDir` throws for the web app (the overlap rule), and
  after `close()`; it is idempotent. A failed `createWorkletRuntime` no longer
  leaves the console patched. `close()` is idempotent, detaches the IPC
  listener, fails pending host calls, and the console is restored when the
  last runtime closes.
- The mock transport runs the real plugin kernel and manifests: unknown
  permission ids are `unsupported`, unknown media kinds are refused,
  discovery lists `core.logs`, and it warns inside an app shell. It ships in
  the `@ekrooh/bare/transports` bundle, so select it only behind a dev/test
  guard.
- The reference apps fold server log lines into errors only in dev or when
  built with `VITE_BARE_DIAGNOSTICS=true` (the device CI jobs set it). The
  replaced-socket error reads "WebSocket replaced by another page holding the
  session; reconnects in 30 s or when this page returns to the foreground".
- IPv6 hosts are bracketed in the origin.

### Added

- **`@ekrooh/bare/sync`**: peer-to-peer sync of one JSON value per device.
  `createSync` returns invite/join/publish/values/onChange; devices that share
  an invite code see each other's latest value. `hyperswarm` is now a runtime
  dependency.
- `EventSpec.validate` (runtime args check), `EventSpec.hostTimeoutMs`,
  `PluginManifest.hostTimeoutsMs`, the `timeoutMs` argument of
  `delegateToHost`, router `maxInflightPerChannel`/`maxInflightPerPlugin`, and
  the same two options on `WorkletRuntimeOptions`.
- `MessageTransport.close()` (optional) and the `createWebSocketTransport`
  options `minBootWindowMs`, `openTimeoutMs`, `maxQueued`, `diagnostics`;
  `diagnostics` on `createProtocolMessenger`.
- `LoopbackServerOptions.bootstrapTtlMs` and `foldPathCase`;
  `LoopbackServer.pauseBootstrapClock?()`/`resumeBootstrapClock?()` (the
  runtime wires them to Bare `suspend`/`resume`);
  `HostCapabilitiesResponseHeader.error?`.
- Swift: `BareStorage`, `BareStorageDirectories`, `BareStorageError`,
  `BareHandoff`, `BareNavigationPolicy`, `BareNavigationDecision`,
  `BareNavigationDelegate`, `BareWebHost`, `HostIpcRouter`,
  `HostPluginRegistry.register(…timeout:…)`, `invokeTimeout`,
  `defaultInvokeTimeout`, `userMediatedInvokeTimeout`,
  `BareProtocol.buildErrorResponse(…type:)`, `HostPluginRegistry.maxInvokeTimeout`,
  `BareNavigationDecision.loadInPlace`.
- Kotlin: `BareHandoff`, `HostIpcCoordinator.Port` (+ constructor and
  `stop()`), `HostPluginRegistry` timeout overload, `timeoutFor`,
  `DEFAULT_TIMEOUT_MS`, `INTERACTIVE_TIMEOUT_MS`, `FrameDecoder(onInvalidFrame)`,
  `BareHostAbi.isSupportedRuntime`, `BareWebViewClient.shouldOpenExternally`,
  `shouldBlockMainFrameRequest`, `onRenderProcessGone`; `BareWebViewClient` is
  now `open`.
- API snapshots: the JS type surface (`api/public-api.d.mts.snap`,
  `npm run api:snapshot`), the Kotlin API (`android/api/bare-host.api`,
  `apiDump`/`apiCheck`) and the Swift API (`ios/public-api.swift.snap`). The
  `exports` keys are frozen.
- `security.android.test.ts`, `security.apple.test.ts` and
  `error-codes-parity.test.ts`; `docs:check` type-checks every docs snippet
  against `dist/` and rejects known retired APIs.

### Fixed

- **npm license metadata**: `package.json` declared `MIT`, but the `LICENSE`
  file shipped in every tarball, the Maven POMs and upstream Bare / Bare Kit
  are all Apache-2.0. The field now says `Apache-2.0`. The license itself is
  unchanged.

### Removed

- `web/transport-log.ts` (dead code) and the mock-only handlers module.

### Docs

- Fixed snippets that called APIs that do not exist (`transport.invoke`,
  `discovery.summary`, flat builder paths), the frame layout (`payloadLen`),
  the AAR coordinates, the iOS embedding steps, and the media guide (CSPRNG
  mount ids, no native `path` in results). ADRs 0005 and 0006 are marked
  accepted; 0003 notes what 0006 superseded.

## [0.6.2] - 2026-11-07

### Fixed

- **16 KB page size support**: the bundled `libnativehelper.so` is now linked
  with 16 KB LOAD alignment (`ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES`), as Google
  Play requires for 64-bit libs. CI now fails if any `arm64-v8a` or `x86_64`
  `.so` in the AAR is aligned below 0x4000.

## [0.6.1] - 2026-11-01

### Fixed

- **Host invokes work in consumer worklets** (#268): request ids no longer
  read `globalThis.crypto`, which Bare does not provide, so every
  `invokeOnHost` (photo picker, camera) threw before it was sent unless the
  worklet entry installed a Web Crypto shim. Randomness is now injected
  through a `Platform` object: the worklet runtime uses `bare-crypto`, and
  `createProtocolMessenger(send, { platform })` defaults to Web Crypto and
  throws (never falls back to `Math.random`) when none exists. Consumer
  shims that set `globalThis.crypto` for this can be removed.
- **Failed host calls answer instead of hanging** (#268): a failed host
  capabilities query now returns a `HOST_ERROR` response, and any invoke
  whose routing throws gets an error response. Before, the web caller got
  nothing and waited out its timeout.

### Changed

- **Android build toolchain** (#271): the build moved to AGP 9.5 and Gradle 9.6,
  and AGP's built-in Kotlin replaces the `org.jetbrains.kotlin.android` plugin.
  The published AAR is now built with a different Kotlin compiler.
- **SwiftPM binary pin** (#270): `Package.swift` resolves BareKit by pinned
  `url` and `checksum` on `main`, not by a local path.

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
