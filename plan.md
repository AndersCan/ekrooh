# Execution Plan — Loopback transport unification & auth

Status of the `@less/bare` host/transport work. Each phase has concrete tasks,
file paths, and gates. Run the gates from the repo root; the gate for any
change is `vp check` + `vp test` (+ `./gradlew build`, `npm run test:ios`).

Context: on-device, the app's WebView talks to the worklet (Bare runtime)
today over platform-private channels (Android WebMessagePort, iOS
WKScriptMessageHandler). The worklet already runs a loopback HTTP file server
and a WebSocket server. The end goal: **one loopback HTTP+WS server** serves
the web app, the media files, and the protocol socket; the page connects to
`ws://<same-origin>`; auth is a per-session **cookie** (not a URL token).

---

## Phase 1 — iOS host, media, loopback security ✅ DONE

Delivered and verified (see commit history / previous milestones):

- **iOS host** (`ios/`, SPM package `BareHost`): `BareProtocol`, `ErrorCodes`,
  `HostPluginRegistry`, `DefaultHostPlugins`, `HostIpcCoordinator`
  (raw-bytes relay), `BareWebViewBridge` (base64 over WKScriptMessageHandler).
  XCTest suite (14) + reference app UI test. `examples/ios-app` (SwiftUI +
  xcodegen project).
- **Media plugin** (`plugins/media`, `vendor.media`): native pick/capture via
  `HOST_INVOKE_REQUEST`, bytes served out-of-band by the worklet's loopback
  HTTP server (`core/server/static-file-server.ts`); web loads plain URLs.
- **Loopback security**: per-session 32-byte token on the media server
  (`?token=` or `X-Bare-Token` header; 401 otherwise), `Referrer-Policy:
no-referrer` on all responses; optional WS gate (`BARE_WS_TOKEN`);
  `window.__lessBareToken` transport seam (`web/websocket-client.ts`).
- **BareWebViewClient** logs resource errors.

Gates green: `vp check` 0 errors, `vp test` 79, e2e 8, `./gradlew build`,
`npm run test:ios` (14 unit + UI), Android manual (media renders; no-token →
401).

---

## Phase 2 — Unified loopback server + cookie auth (NEXT)

One server, one origin, one auth mechanism.

### Design

- Merge `bare-http1` static server and `bare-ws` upgrade onto **one** loopback
  server (`127.0.0.1`, ephemeral port). `core/server/static-file-server.ts` is
  the natural home; add the WS upgrade + web-asset mount (`/`) + SPA fallback
  to it.
- The worklet serves the built web app at `http://127.0.0.1:<port>/index.html`
  (mount the app bundle dir passed via `Worklet.Configuration.assets`).
- The page connects to `ws://<location.host>` (same-origin → no mixed content,
  no ATS/cleartext carve-outs beyond local networking, no custom scheme).
- **Cookie auth** (replaces the URL token — see design note at bottom):
  - Native shell injects `window.__lessBareToken` (already the seam) +
    a shell marker.
  - Page calls `fetch('/login', { method: 'POST', body: token })`.
  - Server validates and sets `Set-Cookie: bare_session=<nonce>; HttpOnly;
SameSite=Lax; Path=/`.
  - Cookies auto-ride `<img>`/`<video>`/`fetch` and the **WS upgrade request**
    (same-origin), so media URLs drop `?token=` and WS auth uses the cookie.
  - Keep `X-Bare-Token`/query-token acceptance as fallback for non-browser
    clients (defense in depth).
- **Port handoff** worklet → host: host must know the ephemeral port + token
  before loading the page. Design decision: worklet writes
  `{ port, token }` to a file the host reads (app sandbox; host passes the
  writable dir via `Worklet.Configuration.assets`), or host polls a fixed
  path. (Ratify: file handoff is recommended; no wire-protocol change allowed.)
- **Hosts**: WebView loads `http://127.0.0.1:<port>/index.html`; never restore
  a stale origin (always re-navigate on start).

### Tasks (ordered)

1. [ ] Merge servers: single `bare-http1` server with `bare-ws` upgrade +
       static mounts + SPA fallback; bind `127.0.0.1` ephemeral; expose
       `origin()`. (`core/server/static-file-server.ts`,
       `core/server/websocket-server.ts`)
2. [ ] Serve the web app: worklet mounts the app bundle dir at `/`; hosts pass
       the assets dir via `Worklet.Configuration(assets:)` / the Kotlin
       equivalent.
3. [ ] `/login` endpoint + session cookie (HttpOnly, SameSite=Lax); WS upgrade
       validates cookie; media requests validate cookie. Keep query/header
       token as fallback.
4. [ ] Port/token handoff file; hosts read it and load the page.
5. [ ] Web: `createWebSocketTransport` same-origin default (`ws://location.host`)
   - boot-window reconnect with backoff (250ms→2s, ~5 tries); explicit URL
     escape hatch for browser dev (`VITE_BARE_WS_URL` or transport arg).
     (`web/websocket-client.ts`, `examples/web/transport.ts`)
6. [ ] Delete the bridges: `web/transports/bootstrap-bridge.ts` + test,
       `web/transports/bootstrap-bridge-wkwebview.ts` + test,
       `android/.../BarePortMessenger.kt`, `ios/.../BareWebViewBridge.swift`,
       `examples/ios-app/app/BareAssetSchemeHandler.swift`, `BareShellMarker`.
       Trim `examples/web/transport.ts` to mock → WS.
7. [ ] Hosts: register the `/login`/cookie flow; inject `__lessBareToken` +
       shell marker. iOS `BareRuntime`, Android `MainActivity`.
8. [ ] Server hardening: origin check on WS upgrade, single-client policy,
       idle timeout.
9. [ ] Media plugin: `url(path)` stops appending `?token=` (cookie handles
       auth). (`plugins/media/plugin.ts`)
10. [ ] Tests: update `websocket-client.test.ts` (same-origin default, retry);
        drop bridge tests; mock stays; e2e (mock) untouched; iOS UI test still
        asserts full stack (discovery / ping / media render); Android manual.

### Gates (Phase 2)

`vp check` · `vp test` · `npm run test:e2e:web` · `./gradlew build` ·
`npm run test:ios` (14 unit + UI incl. media render) · Android emulator manual
(media renders; no cookie → 401; no token → 401).

---

## Phase 3 — Release readiness

1. [ ] **iOS CI**: add a macOS-runner job (test.yml) running `npm run
build:ios && npm run test:ios`; decide whether the release workflow
       publishes iOS artifacts on the tag (source ships in `ios/` regardless).
2. [ ] **Streaming**: replace whole-file reads in the static server with
       `bare-fs.createReadStream` + `pipe` (range support) for large video.
3. [ ] **Surface freeze**: confirm the `@less/bare` exports map (add/remove
       the WKWebView/bridge transports per Phase 2) before the first publish.
4. [ ] **`vendor.media` placement**: ratify whether it stays a default plugin
       (discovery shows 4) or moves to an example-only worklet entry (keeps the
       reference at 3). vision.md flags product features as consumer-owned.
5. [ ] Final docs: README/AGENTS/vision/RELEASING reflect the unified server +
       cookie auth; `RELEASING.md` notes iOS verification step.

---

## Constraints (all phases)

- **Never** change the wire protocol, plugin contracts, JS `exports` map
  contracts, or the Kotlin host API without the human (major-version events).
  Phase 2 deletes _internal_ transports/bridges — allowed pre-1.0, but the
  `@less/bare/transports` export shape must be ratified before publish.
- Never commit build output (`prebuilds/`, `*.gen.js`, bundled web assets,
  `examples/ios-app/addons/`, `examples/ios-app/Resources/`).
- Cookie design note: cookies are per-origin + SameSite-gated, so they only
  work once the page shares the loopback origin — that's why Phase 2 lands
  them (Phase 1's URL token was the only cross-origin-safe option, and is
  sound for the loopback threat model).
