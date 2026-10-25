# Loopback auth surface: one explicit bootstrap, cookie + header credentials only

## Context

The unified loopback server binds `127.0.0.1` on an ephemeral port and serves the
web app, media mounts, custom routes and the protocol WebSocket from one origin.
`core/server/static-file-server.ts` is the trust boundary. Anything local that can
reach `127.0.0.1` must not be able to drain all media. Review (ekrooh#51, #52) found
three under-scoped boundaries:

1. **Token in URL.** `isAuthorized` accepted `?token=`. URLs leak to history, logs,
   referrers and page JS. The `X-Bare-Token` header already serves every non-browser client.
2. **Raw token in page JS.** The shell injected `window.__ekrooh = { token }`. Any page
   script could mint requests to every gated resource, since one shared token has no
   per-resource scope.
3. **Publicness keyed on mount kind.** `publicResource = mount.kind === 'dir'` made
   every directory mount, and via SPA fallback the whole app, world-readable pre-auth.

## Decision

Authorization:

- Remove `?token=`. `isAuthorized` accepts only the `bare_session` cookie nonce or
  the `X-Bare-Token` header.
- The page never sees the raw token. The host exchanges a single-use bootstrap nonce
  for the session cookie via `POST /login` (the nonce is invalidated on redemption;
  the session token is also accepted for host-driven calls). `handoff.json` carries
  `bootstrap` for the page and `token` for the host's own IPC.
- Per-resource capability tokens are deferred and not scheduled. Media mounts use
  unguessable per-session ids and share one cookie, so the residual risk is bounded
  to the session lifetime.

Public surface:

- Publicness is explicit: `mountDir(prefix, dirPath, { public: true })`. The web app
  at `/` is the only public mount. All other directory mounts are gated like file mounts.
- SPA `index.html` fallback applies only to public mounts. Other directory mounts 404
  unknown paths.
- Public (pre-auth): the bootstrap page at `/`, which must load before it can `POST /login`.
- Gated: every file mount, the WS upgrade, custom routes, and non-public directory mounts.

## Rationale

- A token in a URL is a stealable bearer credential. The header and cookie paths
  cover all legitimate clients, so the query param is pure surface.
- A single-use nonce still lets the page log itself in, and caps what a later-stolen
  page script can do. The cookie is `HttpOnly`.
- The real token stays in `handoff.json` in host-sandbox storage, which page JS cannot read.
- An explicit `{ public: true }` makes bootstrap a deliberate, auditable decision.

## Consequences

- `handoff.json` gains `bootstrap` (additive; `token` stays). `LoopbackServer.credentials()`
  return type changes.
- Reference hosts (`MainActivity.kt`, `BareRuntime.swift`) inject
  `window.__ekrooh = { bootstrap }`, not `{ token }`.
- The web transport reads `window.__ekrooh.bootstrap`, falling back to a legacy
  `token`. It never puts a credential in a URL.
- The `?token=` path and `tokenFromQuery` are removed. Grep confirmed no other caller.
  Its co-located test asserts rejection.
