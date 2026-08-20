# Loopback auth surface: one explicit bootstrap, cookie + header credentials only

## Context

The unified loopback server on device binds `127.0.0.1` on an ephemeral port and
serves the web app, media mounts, custom routes, and the protocol WebSocket
from a single origin. `core/server/static-file-server.ts` is the sole
trust boundary between "the loopback server is a private per-app capability"
and "anything local that can reach `127.0.0.1` can drain all media."

An architectural review (ekrooh#51, #52) found three under-scoped trust
boundaries:

1. **Token-in-URL.** `isAuthorized` accepted a `?token=` query param. A URL is
   observable by browser history, a local log, a referral/log, page JS, or a
   plugin — anyone who reads the URL learns the bearer credential. Non-browser
   clients are served by the `X-Bare-Token` header, so the query param had no
   on-device consumer the header didn't already serve.
2. **Raw token in page JS.** The shell injected `window.__ekrooh = { token }`.
   Any script running in the page (a third-party bundle, a consumer plugin
   dispatch handler) could read the token and mint `X-Bare-Token` requests to
   **every other** gated resource on the same origin — there is a single shared
   token, so no per-resource/capability scoping limited the blast radius.
3. **Publicness keyed on mount kind.** `publicResource = mount.kind === 'dir'`
   made **every** directory mount (and via the SPA fallback the whole app
   bundle) world-readable pre-auth. Publicness should be an explicit opt-in
   marker on the bootstrap page, not a property of the mount kind.

## Decision

### Authorization surface

- **Remove the `?token=` query-param path.** `isAuthorized` accepts only the
  `bare_session` cookie nonce or the `X-Bare-Token` header.
- **The page never sees the raw token.** The host exchanges the bootstrap
  nonce for the session cookie via `POST /login`. On the server, `POST /login`
  accepts either the session token (non-browser / host-driven) or a
  **single-use bootstrap nonce** that is invalidated the moment it is
  redeemed. `credentials()`/`handoff.json` carry `bootstrap` for the page and
  `token` for the host's own IPC needs.
- **Per-resource capability tokens: deferred.** Full per-resource tokens are
  out of scope for this change. Because media mounts already use unguessable
  per-session mount ids and share one cookie, the residual risk (a page script
  that already ran auth can fetch media) is bounded to the session lifetime.
  Recorded as a future enhancement, not scheduled.

### Public (bootstrap) surface

- **Publicness is explicit.** `mountDir(prefix, dirPath, { public: true })`
  marks a directory mount as world-readable bootstrap content. The web app at
  `/` is the only mount the framework marks public. Every other directory
  mount is auth-gated like a file mount.
- **SPA fallback is scoped to the public mount.** `resolveDirFile` applies the
  `index.html` fallback only for public mounts; a non-bootstrap directory mount
  404s unknown paths, so unauthenticated clients never receive bootstrap HTML.
- **What must be public vs gated** on the single loopback origin:
  - **Public (pre-auth):** the bootstrap page itself — the bundled web app at
    `/` that the fresh WebView must load before it can `POST /login`. This is
    the chicken-and-egg tradeoff that justifies a public surface at all.
  - **Gated:** every file mount (media), the WS upgrade, custom routes, and any
    non-public directory mount.

## Rationale

- A token in a URL is a bearer credential an observer can steal; the header and
  cookie paths cover every legitimate client, so the query param is pure
  surface.
- A one-time bootstrap nonce still lets the page log itself in (preserving the
  device UX) but caps what a page script stolen later can do: the nonce is
  spent on first login and the cookie is `HttpOnly`, so a third-party script
  cannot mint arbitrary authorized requests.
- The host keeps the real token in `handoff.json` (in the host-sandbox storage
  dir that page JS cannot read) for anything that must present the session
  token/header — the page never receives it.
- Explicit `{ public: true }` makes bootstrap-ness a deliberate, auditable
  decision instead of an emergent property of serving a directory.

## Consequences

- `handoff.json` gains a `bootstrap` field (additive; `token` stays for the
  host). The `LoopbackServer.credentials()` return type changes.
- The reference hosts (`MainActivity.kt`, `BareRuntime.swift`) inject
  `window.__ekrooh = { bootstrap }`, not `{ token }`.
- The web transport reads `window.__ekrooh.bootstrap` (preferred), falling back
  to a legacy `token` for backward-compat consumers; it never puts a credential
  in a URL.
- The `?token=` path and the `tokenFromQuery` helper are removed (grep confirmed
  no other caller; its co-located test is updated to assert rejection).
