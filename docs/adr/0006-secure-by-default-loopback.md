# Loopback admission: the origin rule holds in every mode, device mode is the default, and only the bootstrap nonce logs a page in

Status: proposed. Needs owner approval before it binds (it changes defaults of
`@ekrooh/bare/runtime` exports and the `/login` contract). Extends ADR 0003.

## Context

ADR 0003 hardened the loopback server for device mode. Three gaps remained:

1. **Auth off disabled the origin rule too.** `isAuthorized` and
   `originAllowed` both returned `true` when auth was off, and the WebSocket
   upgrade skipped its `Origin` check. WebSocket upgrades are not subject to
   CORS, so any website open in a browser on the same machine could open
   `ws://127.0.0.1:8080` against a dev backend and invoke every plugin,
   including host-delegated ones. Plain HTTP was reachable by DNS rebinding.
2. **Auth was inferred, with three different defaults.**
   `createLoopbackServer` defaulted to auth on, `createWorkletRuntime` to
   `storage !== undefined`, and `resolveCliConfig` to auth off on port 8080.
   `createWorkletRuntime({ webAssets, plugins })` produced an unauthenticated
   server; a device host whose directories failed the positional check fell
   back to dev mode; the desktop sidecar was secure only because its host
   passed `auth=on`.
3. **The raw session token was still a `/login` credential**, and the web
   transport still read `window.__ekrooh.token`, kept as a legacy fallback by
   ADR 0003. A page given the token holds a credential that never expires.

## Decision

- **One admission module** (`core/server/loopback-gate.ts`, the loopback gate)
  owns the session token, the single-use bootstrap nonce, the cookie and the
  origin rule. The HTTP handler, the WebSocket upgrade and `POST /login` only
  write its verdict.
- **The origin rule is independent of auth.** `Host` must be the bound
  `host:port` or a loopback alias on the bound port (`127.0.0.1`, `localhost`,
  `[::1]`). An `Origin`, when present, must be the bound origin, a loopback
  alias of it, or listed in `allowedOrigins` (`LoopbackServerOptions`,
  `WorkletRuntimeOptions`, CLI `origin=`). With auth on, an upgrade without an
  `Origin` is refused.
- **Device mode is the default.** `createWorkletRuntime` defaults
  `deviceMode` to `true` (auth on, ephemeral port). Dev mode is chosen only by
  `deviceMode: false` or the CLI token `mode=dev`. `resolveCliConfig` keeps the
  device defaults without `mode=dev`. `core/desktop.core.ts` forces
  `deviceMode: true, auth: true`.
- **Only the bootstrap nonce (or a live session) logs a page in.** `/login`
  no longer accepts the raw token; the web transport no longer reads
  `window.__ekrooh.token`. The token remains valid as the `X-Bare-Token` header
  for the host's own calls.
- The session cookie is `SameSite=Strict`. HTML responses send
  `connect-src 'self' ws://<admitted host>` instead of `ws:`.

## Consequences

- **Breaking** for consumers that relied on the inferred dev mode (a bare CLI
  run with no `mode=dev`, or `createWorkletRuntime` without `storage`), that
  inject `window.__ekrooh.token`, or that log in with the raw token. Dev
  runners must pass `mode=dev` and their page origins (`scripts/dev-bare.mjs`
  and `examples/consumer-basic/scripts/boot-worklet.mjs` do). This ships in a
  major release.
- `WorkletRuntimeOptions.allowedOrigins` and `LoopbackServerOptions.allowedOrigins`
  are new (additive). `getIPC()` now returns `null` without a host.
- Per-resource capability tokens stay deferred, as in ADR 0003.
