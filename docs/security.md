# Security model and review checklist

The system of record for routine security reviews. A review walks this file top
to bottom, and a change that moves a trust boundary updates it in the same PR.
Decisions live in ADRs (0003, 0005, 0006); this file says where each one is
enforced and how to check it still holds.

## Assets

- **Plugin surface.** Whoever holds a protocol socket can invoke every
  registered plugin, including host-delegated ones (camera, picker,
  permissions, and whatever a consumer registers).
- **Session credentials.** The session token (`X-Bare-Token`), the
  `bare_session_<port>` cookie derived from it, and the single-use bootstrap nonce.
- **Gated files.** Media mounts, non-public directory mounts, the log ring
  (`GET /logs`).
- **Release artifacts.** The npm package, the AAR, the Swift package, and the
  Bare Kit prebuilds they embed.

## Attackers

| Attacker                                   | Reaches                                                          | Must not get                                    |
| ------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------- |
| A website open in a browser on the machine | `127.0.0.1:<port>` through the browser (CORS, WS, DNS rebinding) | Any plugin call, any gated byte                 |
| Another app or process on the device       | `127.0.0.1:<port>` directly, any headers it likes                | The token, the nonce, any gated byte            |
| Content the app displays                   | The app origin, if it is ever served as a document from a mount  | Script in the app origin                        |
| A p2p peer                                 | Whatever the consumer stores and mounts from it                  | Script in the app origin, paths outside a mount |
| A compromised dependency or CI step        | The build, the release job's OIDC token and signing secrets      | A published artifact                            |

Out of scope: an attacker with root on the device, or one who controls the host
app's own native code.

## Trust boundaries and their invariants

Each invariant names the code that enforces it and the test that pins it. A
review checks that both still exist and still say this.

### 1. Loopback admission (`core/server/loopback-gate.ts`)

- `Host` must be the bound `host:port` or a loopback alias on that port, in
  every mode (dev included). Pinned by `loopback-gate.test.ts`.
- An `Origin`, when present, must be the bound origin, an alias, or an explicit
  `allowedOrigins` entry. With auth on, a WS upgrade without `Origin` is refused.
- Credentials are compared in constant time (`secretEquals`).
- The token never appears in a URL or in page JS. The page gets only the
  bootstrap nonce, which `/login` accepts once.
- The cookie is `HttpOnly; SameSite=Strict`.
- Device mode (auth on, ephemeral port) is the default. Only `mode=dev` or
  `deviceMode: false` turns auth off. `core/desktop.core.ts` forces auth on.
- With auth off, the server binds only a loopback address
  (`createLoopbackServer` throws otherwise): the Host/Origin rule stops
  browsers, not a client on another machine.

### 2. HTTP serving (`core/server/static-file-server.ts`)

- Only a `{ public: true }` directory mount (the web app at `/`) is served
  before login. Routes, file mounts and other directory mounts are gated.
- A request path never resolves outside its mount: segments are decoded once,
  `.`/`..`/separators/NUL are refused, and the real path (symlinks resolved)
  must stay inside the mount root.
- Every response carries `Referrer-Policy: no-referrer` and file responses
  carry `X-Content-Type-Options: nosniff`.
- Only the public mount is app code. HTML from it gets the strict CSP
  (`cspFor`). Every other served file (file mounts and gated directory mounts)
  gets the sandbox CSP (`MOUNTED_FILE_CSP`), so a hostile HTML or SVG opened as
  a document runs in an opaque origin.
- Bodies read before auth are capped (`/login`: 4 KiB). A 500 never echoes an
  exception message.
- `POST /logs` entries are truncated (`MAX_INGEST_*` in `core/logs/routes.ts`),
  so the ring's memory is bounded, and the text read-back escapes line breaks
  so a page entry cannot pose as a backend line.

### 3. Protocol socket and wire codec (`core/server/protocol-socket.ts`, `core/messages/`)

- One live socket. A replacement must pass the same gate and is rate limited.
- Frames are capped at `MAX_FRAME_BYTES`, headers at `MAX_HEADER_BYTES`
  (ADR 0005). The cap cannot be raised by an option.
- Decoded headers are rebuilt from an allowlist of fields, so unknown keys
  (`__proto__`) never reach plugin code.
- A web client cannot answer a host call: `HOST_*_RESPONSE` frames are only
  consumed from the host IPC channel, and the bridge puts its own CSPRNG id on
  each host call instead of the page's `requestId` (`core/messages/host-ipc.ts`).
- Inflight calls, pending host calls and the outbound queue are all bounded.

### 4. Plugin arguments

- Event specs are compile-time types only. **Nothing validates `args` at
  runtime**, so every plugin handler that uses an argument as a path, URL,
  command, permission id or mount key must check it itself (`vendor.media`
  allowlists `kind`; host handlers allowlist permission ids).

### 5. Native hosts (`android/`, `ios/`, `examples/*-app`)

- The WebView is confined to the loopback origin; other top-level navigations
  go to the system browser (Android `BareWebViewClient.allowedOrigin`, iOS
  `BareNavigationDelegate`). The Android WebView has file and content access
  off.
- The bootstrap script is injected only into the loopback origin, and the
  handoff file is deleted once the page has loaded.
- Cleartext is allowed only to `127.0.0.1`/`localhost` (Android network
  security config, iOS `NSAllowsLocalNetworking`).
- App storage is excluded from backup. The FileProvider exposes only
  `cache/captures/`.

### 6. Build and release (`.github/workflows/`, `scripts/fetch-prebuilds.mjs`)

- Every action is pinned to a full commit SHA. No workflow uses
  `pull_request_target`. Default `permissions` are read-only.
- Prebuilds are checked against `scripts/prebuilds.lock.json` before unpacking,
  and the script refuses to unpack without a real hash.
- Publishing runs in the protected `release` environment with npm trusted
  publishing (OIDC), not a long-lived npm token. That job installs with
  `--ignore-scripts` and rebuilds only allowlisted packages (esbuild); the
  `linux-android` test job uses the same install so CI proves it.
- Dev tooling is not exempt: the harness supervisor (`core/harness/`) hands out
  instance credentials, so it refuses any request with an `Origin` or a
  foreign `Host` and sends no CORS header.

## Mechanical checks

`security.test.ts` (repo root, runs in `vp test`) fails the build when a cheap,
greppable invariant regresses: HTML-injection sinks in shipped code, wildcard
CORS anywhere in `core/` or `plugins/`, `Math.random` in id-minting code,
unpinned actions, `pull_request_target`, a release install that runs
dependency scripts, a placeholder prebuild hash. Extend it when a new
invariant can be checked by reading files; prefer a behavior test next to the
code when it cannot.

## Accepted risks

- Per-resource capability tokens are deferred (ADR 0003). Any holder of the
  session can read every gated mount for the session's lifetime.
- The loopback is cleartext. Another process on the device can observe it only
  with privileges that are out of scope.
- Dev mode (`mode=dev`) has no credential. The origin rule still applies, but a
  non-browser process on the machine can drive a dev backend.

## Running a review

Use the `security-review` skill (`.agents/skills/security-review/SKILL.md`).
File each finding as a GitHub issue labelled `security` (see
`docs/agents/issue-tracker.md`); report a vulnerability that affects a published
release privately (see `SECURITY.md`) rather than in a public issue.
