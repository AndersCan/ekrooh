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

| Attacker                                   | Reaches                                                                                    | Must not get                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| A website open in a browser on the machine | `127.0.0.1:<port>` through the browser (CORS, WS, DNS rebinding)                           | Any plugin call, any gated byte                 |
| Another app or process on the device       | `127.0.0.1:<port>` directly, any headers it likes                                          | The token, the nonce, any gated byte            |
| Another listener on `127.0.0.1`            | The session cookie (cookies are not port-isolated), a same-site page that loads our URLs   | Any gated byte, any plugin call                 |
| Content the app displays                   | The app origin, if it is ever served as a document from a mount                            | Script in the app origin                        |
| A p2p peer                                 | Whatever the consumer stores and mounts from it                                            | Script in the app origin, paths outside a mount |
| A compromised dependency or CI step        | The credential-free build job; Gradle and its plugins also run in `publish-maven` (see §6) | A published artifact                            |

Out of scope: an attacker with root on the device, or one who controls the host
app's own native code.

## Trust boundaries and their invariants

Each invariant names the code that enforces it and the test that pins it. A
review checks that both still exist and still say this.

### 1. Loopback admission (`core/server/loopback-gate.ts`)

- `Host` must be the bound `host:port` or a loopback alias on that port, in
  every mode (dev included). An IPv6 bind is bracketed in the origin. Pinned by
  `loopback-gate.test.ts`.
- An `Origin`, when present, must be the bound origin, an alias, or an explicit
  `allowedOrigins` entry. With auth on, a WS upgrade without `Origin` is refused.
- **Fetch metadata.** Cookies are scoped to the host, not the port (RFC 6265
  §8.5), so a page on another `127.0.0.1` port is same-site and
  `SameSite=Strict` still attaches our cookie to its no-`Origin` GETs. With
  auth on, a gated request or upgrade whose `Sec-Fetch-Site` is not
  `same-origin` or `none` is refused with 403 (`checkFetchSite`). A request
  without the header is judged by the Host/Origin rule alone. A request whose
  `Origin` is exactly an `allowedOrigins` entry is exempt (it is listed because
  it is cross-site); a no-`Origin` request never is. The public mount and dev
  mode are not affected. Pinned by `loopback-gate.test.ts` ("refuses a
  credentialed gated request with Sec-Fetch-Site: %s", "exempts an explicitly
  allowed origin, never a no-Origin request").
- The port in the cookie name (`bare_session_<port>`) only stops two ekrooh
  servers from overwriting each other's session. It does not keep the cookie
  from being sent to another loopback listener; the Fetch-metadata rule and
  the Host rule are what refuse such a request.
- Credentials are compared in constant time (`secretEquals` →
  `timingSafeEqual`). Pinned by `loopback-gate.test.ts` ("compares every
  credential through timingSafeEqual").
- The token never appears in a URL or in page JS. The page gets only the
  bootstrap nonce, which `/login` accepts once, and only while it is live:
  - its lifetime is `BOOTSTRAP_TTL_MS` (120 s) of **running** time counted
    from the first public page request (normally the host loading the page; a `POST /login` that
    arrives before any page load is accepted only inside the 600 s unloaded
    window below);
  - the clock pauses while the Bare worklet is suspended (`suspend`/`resume`
    → `pauseBootstrapClock`/`resumeBootstrapClock`, wired in
    `core/runtime.ts`), so an app backgrounded between page load and login
    still logs in;
  - a nonce whose page never loads expires after
    `BOOTSTRAP_UNLOADED_TTL_MS` (600 s) of running time from bind;
  - `bootstrapTtlMs` on `LoopbackServerOptions` overrides the 120 s; a
    non-positive or non-finite value falls back to it, and it is capped at
    `BOOTSTRAP_TTL_MAX_MS` (600 s);
  - an expired nonce never comes back; a reload logs in with the surviving
    session cookie.

  Pinned by `loopback-gate.test.ts` ("bootstrap nonce lifetime") and
  `runtime.test.ts` ("pauses the bootstrap clock across a Bare suspend and
  resumes it only on resume").

- The cookie is `HttpOnly; SameSite=Strict`.
- Device mode (auth on, ephemeral port) is the default. Only `mode=dev` or
  `deviceMode: false` turns auth off; `createWorkletRuntime({ auth: false })`
  without `deviceMode: false` throws (`core/runtime.ts`, pinned by
  `runtime.test.ts` "refuses auth: false in device mode").
  `core/desktop.core.ts` forces auth on (`security.apple.test.ts`, desktop
  section).
- With auth off, the server binds only a loopback address
  (`createLoopbackServer` throws otherwise): the Host/Origin rule stops
  browsers, not a client on another machine.
- `handoff.json` holds `{ origin, port, bootstrap }` only, and is written
  atomically (temp file + rename) with mode `0600` (`writeHandoffFile`,
  pinned by `runtime.test.ts` "writes handoff.json atomically, owner-only").

### 2. HTTP serving (`core/server/static-file-server.ts`)

- Only a `{ public: true }` directory mount (the web app at `/`) is served
  before login. Routes, file mounts and other directory mounts are gated.
- **No gated root inside the public one.** `mountDir` throws when a gated
  directory root is inside or equal to the public root, in either mount
  order, compared by real path. Paths are case-folded and NFC-normalized only
  where the filesystem ignores case (darwin, ios, win32; `foldPathCase`
  overrides). A gated root strictly **around** the public root is allowed: it
  only re-serves public files, sandboxed. The public mount also 404s any file
  whose real path is inside a gated directory mount, even one that became
  reachable after mounting (gated roots are resolved once and cached). Pinned
  by `static-file-server.test.ts` ("refuses a gated directory mount inside or
  equal to the public root, in either order", "folds case only where the
  filesystem does", "allows a gated root strictly around the public root…",
  "never serves a gated root through the public mount…"). Gated **file** mounts are not covered: see
  Accepted risks.
- A request path never resolves outside its mount: segments are decoded once,
  `.`/`..`/separators/NUL are refused, and the real path (symlinks resolved)
  must stay inside the mount root. The file is then opened and served from
  that descriptor, and re-verified after open (the path still resolves to
  itself and to the same `dev`/`ino`), so a symlink swapped in between check
  and open is refused. An unreadable file-mount target is a 404. Pinned by
  `static-file-server.test.ts` ("refuses a file whose path is swapped for a
  symlink after realpath").
- Framework responses and custom routes carry `Referrer-Policy: no-referrer`
  and `X-Content-Type-Options: nosniff`; route responses start with them
  already set. With auth on, gated responses and routes also carry
  `Cross-Origin-Resource-Policy: same-origin`, `allowedOrigins` or not; with
  auth off (dev) it is left off so the Vite dev page can embed backend media.
  Pinned by `static-file-server.test.ts` ("sends Referrer-Policy and nosniff
  on every framework response and route", "keeps
  Cross-Origin-Resource-Policy: same-origin when allowedOrigins is set").
- A route that fails after its response has ended is only logged (no second
  500, no destroyed socket), and a 500 for a failed route drops every header
  the handler had set (a half-written `Set-Cookie` never leaks). Pinned by
  `static-file-server.test.ts` ("drops headers the handler set before
  answering its failure with a 500").
- Only the public mount is app code. HTML from it gets the strict CSP
  (`cspFor`). Every other served file (file mounts and gated directory mounts)
  gets the sandbox CSP (`MOUNTED_FILE_CSP`), so a hostile HTML or SVG opened as
  a document runs in an opaque origin.
- `registerRoute` paths are normalized like mount paths (an invalid one
  throws), so the route key matches what a request resolves to. A route that
  throws **or rejects** is answered with a bare 500 and never becomes an
  unhandled rejection in the worklet (pinned: "answers an async route that
  rejects with a bare 500…", "normalizes a route path like a mount path").
- Bodies read before auth are capped (`/login`: 4 KiB); an oversized `/login`
  body is a 413 and the connection is closed (pinned: "drops the connection
  after refusing an oversized /login body").
- A 500 never echoes an exception message **in its body**. The cause is
  logged, and the log ring is readable by the session holder (`GET /logs`),
  so an exception message is visible to anyone who already holds the session.
- `POST /logs` entries are truncated (`MAX_INGEST_*` in `core/logs/routes.ts`),
  captured backend console messages are capped at 16 KiB
  (`MAX_CAPTURED_MESSAGE_CHARS`, `core/logs/capture.ts`), and upgrade-rejection
  log lines are rate limited (10 per 10 s, then a suppressed count) and
  truncated to 200 characters (`createRejectionLogger`), so a website cannot
  flood the ring. The text read-back escapes line breaks so a page entry cannot
  pose as a backend line.

### 3. Protocol socket and wire codec (`core/server/protocol-socket.ts`, `core/messages/`)

- One live socket. A replacement must pass the same gate and is rate limited.
  The evicted socket is closed with WebSocket code 4001 `"replaced"`
  (`REPLACED_CLOSE_CODE`) and any frame it still sends is dropped (pinned by
  `protocol-socket.test.ts` "closes an evicted socket with 4001
  \"replaced\" and stops reading it"). The web client then waits 30 s or a
  foreground before reconnecting, so two documents cannot evict each other in
  a loop.
- Frames are capped at `MAX_FRAME_BYTES`, headers at `MAX_HEADER_BYTES`
  (ADR 0005). The cap cannot be raised by an option. Kotlin and Swift mirror
  the limits and the 256-byte field cap (`security.apple.test.ts` "frame
  limits and the field cap match").
- Decoded headers are rebuilt from an allowlist of fields, so unknown keys
  (`__proto__`) never reach plugin code; `args`/`result` are rebuilt without a
  prototype. `pluginId`, `event` and `requestId` are at most 256 UTF-8 bytes
  (`MAX_ID_LENGTH`, `core/messages/frame-content.ts`), and invalid UTF-8 is
  `FRAME_INVALID`.
- A frame with invalid **content** is skipped on its own (an
  `INVOKE_REQUEST` is answered `FRAME_INVALID`) and the stream stays open; a
  bad host response fails its pending call at once. Only a **framing**
  violation closes the WebSocket (`core/messages/frame-channel.ts`, pinned by
  `frame-channel.test.ts` "answers a request whose content is invalid with
  FRAME_INVALID and keeps the stream").
- A web client cannot answer a host call: `HOST_*_RESPONSE` frames are only
  consumed from the host IPC channel, and the bridge puts its own CSPRNG id on
  each host call instead of the page's `requestId` (`core/messages/host-ipc.ts`).
  Pinned by `websocket-server.test.ts` ("ignores a forged HOST_INVOKE_RESPONSE
  sent over the protocol socket").
- Inflight calls, pending host calls and the outbound queue are all bounded.
  The router caps calls at `maxInflight` (64) and per channel (three
  quarters); a per-plugin cap applies only when `maxInflightPerPlugin` is set
  (default: `maxInflight`, i.e. none). Over a cap is `TRANSPORT_ERROR` (pinned
  by `plugin-kernel.test.ts` "caps calls per channel…", "caps calls per plugin
  when maxInflightPerPlugin is set"). Timers are capped at 2^31−1 ms. Pending host calls are capped at 1024, oldest evicted (pinned by
  `host-ipc.test.ts` "evicts the oldest pending host call past the 1024 cap").
- **No exception text reaches the page.** A thrown plugin or routing error is
  answered with a fixed message (`<pluginId>.<event> failed`) and the detail is
  logged (`thrownError` in `core/messages/plugin-kernel.ts`, pinned by
  `plugin-kernel.test.ts` "keeps a canonical CoreError code from a throw but
  never its message"). Host error codes are allowlisted (canonical, or
  app-scoped `ns.x/code` up to 64 characters; anything else is `HOST_ERROR`)
  and host messages are capped at 512 characters (`sanitizeHostError`, pinned
  by `host-ipc.test.ts` "passes canonical and app-scoped host error codes
  only…"). Timeout rejections omit server log lines unless the messenger or
  transport has `diagnostics: true`.

### 4. Plugin arguments

- Event specs are compile-time types. **Nothing validates `args` at runtime
  unless the spec has a `validate` hook** (`EventSpec.validate`, run by the
  `definePlugin` adapter, which answers `PLUGIN_ERROR` before the handler on a
  false result). Every plugin handler that uses an argument as a path, URL,
  command, permission id or mount key must validate it, by hook or in the
  handler: `vendor.media` allowlists `kind`, `core.logs` rejects a non-number
  `tail` and unknown `level`/`source`, and host handlers allowlist permission
  ids (unknown or missing ids are `unsupported` on Android, iOS and the mock).
- Plugin ids are validated at registration: namespaced, at most 256 UTF-8 bytes
  characters, and `core.*`/`vendor.*` are reserved for the framework's own
  plugins (`createPluginRegistry`, pinned by `plugin-kernel.test.ts` "rejects
  malformed ids and reserves core.* / vendor.* for framework plugins").
- `vendor.media` mount ids come from `bare-crypto` (`randomBytes(16)`), and the
  plugin returns only the URL, never the native path.

### 5. Native hosts (`android/`, `ios/`, `examples/*-app`)

Android (`android/`, `examples/android-app`; file checks in
`security.android.test.ts`, behavior in the JUnit tests in `android/src/test`
and the emulator journey `ReferenceJourneyTest`):

- The WebView is confined to the loopback origin by
  `BareWebViewClient.allowedOrigin`. GET navigations off-origin are refused in
  `shouldOverrideUrlLoading`; POST navigations (form submits, which never
  reach it) get an empty 403 in `shouldInterceptRequest`. An http(s) link opens
  in the system browser only on a user gesture (`CATEGORY_BROWSABLE`); a meta
  refresh or script redirect is only cancelled; userinfo URLs are refused.
  The WebView has file and content access off and no JS interface.
- The bootstrap is injected with `addDocumentStartJavaScript` on the handoff
  origin only, after a `DOCUMENT_START_SCRIPT` feature check. The handoff is
  read only through `BareHandoff.consume`, which deletes it as it reads it and
  never logs it.
- Frames go to the IPC only through the serialized writer, which handles
  partial writes.
- Durable storage is `noBackupFilesDir/bare` (never the cache dir); backup is
  off and every domain, `root` and the `device_*` domains included, is
  excluded from full backup, cloud backup and device transfer.
- `MainActivity` is the only exported component (`launchMode="singleTop"`);
  the worklet runs once per process in the `Application`, so another
  activity instance never starts a second backend. Only the first WebView gets
  the bootstrap nonce; later ones log in with the cookie. A failed storage
  migration falls back to the legacy directory and is retried each launch. The FileProvider is private and exposes only
  `cache/captures/`.
- Cleartext is allowed only to `127.0.0.1`/`localhost` (network security
  config `base-config` cleartext off).
- The public Kotlin API is dumped to `android/api/bare-host.api` and checked
  by `apiCheck` on every `./gradlew check`.

iOS (`ios/Sources/BareHost/BareWebHost.swift`; checks in
`security.apple.test.ts`, behavior in `ios/Tests/BareHostTests`):

- Confinement, storage and handoff live in the `BareHost` library, not only in
  the example app: `BareNavigationDelegate`/`BareNavigationPolicy` confine the
  main frame to the handoff origin (subframes app-origin only; off-origin links
  open in Safari only on user activation; `target=_blank` opens Safari), and
  the reference app uses them (installed before any page load).
- `BareWebHost.configure` turns link previews off and the view not
  inspectable. `BareWebHost.load` injects an origin-guarded, main-frame-only
  document-start script and removes all user scripts after the first load.
- `BareHandoff.consume` accepts only an `http://127.0.0.1:<port>` origin and a
  base64url nonce, and deletes the file as soon as it reads it.
- `BareStorage.prepare` keeps storage in `Application Support/bare`, out of
  Documents, and excludes it from backup; failure is fatal. A failed move of a
  legacy `Documents/bare` is retried next launch, and the leftover is excluded
  from backup meanwhile.
- A same-origin `target=_blank`/`window.open` loads in place
  (`BareNavigationDecision.loadInPlace`), never in a second view.
- Host invoke timeouts are clamped to one day
  (`HostPluginRegistry.maxInvokeTimeout`); a non-positive or NaN timeout at
  registration is a precondition failure.
- ATS allows only `NSAllowsLocalNetworking`, which also permits `.local`,
  unqualified names and IP literals; navigation confinement and the CSP are
  what keep the WebView on the loopback origin.
- The permission allowlist fails closed (unknown or missing id is
  `unsupported`); malformed IPC fields are `FRAME_INVALID`; a non-JSON handler
  result is `INVALID_RESPONSE` instead of an uncaught exception.
- The public Swift API is pinned by `ios/public-api.swift.snap`.

Desktop (`examples/desktop-app`; checks in `security.apple.test.ts`, desktop
section):

- The backend always runs with auth on and no handoff file (the nonce goes
  over a private pipe).
- The window is confined to the backend origin before it navigates there
  (`decideNavigation` in `src/main.zig`, native glue in
  `src/harden_darwin.m`/`src/harden_gtk.c`); clicked external links go to the
  system browser. Clipboard read is off. The nonce script is injected on the
  backend origin only. Devtools only with `--debug`.
- The `EKROOH_TEST_HANDOFF_COPY` hook exists only in `-Dtest-hooks=true`
  builds. The webview dependency is pinned to a commit and a content hash.

All hosts: `ErrorCodes` in Kotlin and Swift match `core/messages`
(`error-codes-parity.test.ts`).

### 6. Build and release (`.github/workflows/`, `scripts/fetch-prebuilds.mjs`)

- Every action (workflows, templates, local actions) is pinned to a full
  commit SHA with a matching version comment. No workflow uses
  `pull_request_target` or `workflow_run`. Workflow-level `permissions` are
  read-only and writes are granted per job. Every checkout sets
  `persist-credentials: false`.
- `release.yml` has three jobs. **build** holds no secret, no OIDC and a
  read-only token: it checks that the tag equals the `package.json` version
  and is on `main`, runs `build:pkg`, `docs:check`, `vp check`, `vp test` and
  the Gradle build, and packs the npm tarball and AAR. **publish-npm**
  (`release` environment, `id-token: write`) only publishes that tarball with
  `--ignore-scripts`: no checkout, install or build. **publish-maven**
  (`release` environment, signing and Sonatype secrets) runs only the Gradle
  publish tasks. Both publish jobs wait on the `release` environment.
- Gradle dependency verification is on for the root build
  (`gradle/verification-metadata.xml`), and the wrapper is validated.
- No job holding a credential runs dependency install scripts. `publish-npm`
  first checks npm is at least 11.5.1 (trusted publishing needs it).
- The dependency vuln scan (OSV-Scanner, `test.yml`) scans every npm lockfile
  recursively. Maven is ignored (`.github/osv-scanner.toml`): the only Maven
  input is `gradle/verification-metadata.xml`, a hash list of Gradle
  build-tool jars that are not shipped; the AAR's runtime dependencies are
  tracked by Dependabot instead.
- Prebuilds are fetched from the public release URL with no token, checked
  against `scripts/prebuilds.lock.json` before unpacking (the script refuses a
  placeholder hash), refused if the archive has absolute, `..` or symlink
  entries, re-checked after extraction, and swapped in wholesale. The SwiftPM
  `BareKit.xcframework.zip` pinned in `Package.swift` must match the lockfile,
  and the `ios` CI job checks its contents are the verified prebuild
  (`.github/scripts/verify-spm-binary.mjs`).
- `CODEOWNERS` covers workflows, the prebuild fetcher and lockfile,
  `Package.swift`, the security tests and docs, the Gradle builds and the
  deploy templates. Required checks keep their names and report on every PR
  (docs-only PRs skip the heavy jobs but still report), and the workflows that
  hold them also run on `merge_group`, so a merge queue can be turned on.
  `Dependency review (PR)` is skipped (passes) in the queue: it already ran on
  the PR.
- The deploy templates (`templates/deploy/`) keep every secret in a GitHub
  environment limited to the default branch; production needs reviewers.
- `release-bare-kit-runtime.yml` (`bare-kit-v*` tags) uses the same protected
  `release` environment and the same signing and Sonatype secrets, with only
  `contents: read` and a checkout that drops its token. It runs no npm install: it fetches the hash-checked
  prebuild with Node built-ins, refuses a tag that differs from the lockfile's
  `maven` pin, and publishes only `:bare-kit-runtime`, an unmodified repackage
  of that prebuild ([ADR 0007](adr/0007-separate-bare-kit-runtime-artifact.md)).
  Like `publish-maven`, its Gradle build runs next to the secrets; dependency
  verification covers `:bare-kit-runtime` too.
- Dev tooling is not exempt: the harness supervisor (`core/harness/`) hands out
  instance credentials, so it binds only a loopback host (throws otherwise),
  refuses any request with an `Origin` or a foreign `Host`, sends no CORS
  header, caps live instances (`DEFAULT_MAX_INSTANCES`, 32; 429 past it),
  cleans up a failed allocation, and answers a 500 that carries no exception
  detail (pinned by `core/harness/supervisor.test.ts`).

## Mechanical checks

`security.test.ts` (repo root, runs in `vp test`) fails the build when a cheap,
greppable invariant regresses: HTML-injection and eval sinks in shipped code
(including `['innerHTML']` and `srcdoc`), CORS headers in `core/` or
`plugins/`, `Math.random` in id-minting code, a `globalThis.crypto` read
outside the `Platform` seam; and, with workflows parsed as YAML: unpinned
actions or wrong version comments (templates and local actions included),
`pull_request_target`/`workflow_run`, workflow-level write permissions,
missing `persist-credentials: false`, install scripts in a credentialed job
(segment-aware, so chained or `npx`/`gem`/`bundle` installs count), any step
in an OIDC job outside an action-and-line allowlist, any action in a secrets
job outside an allowlist, non-publish steps in a secrets job, a rename-blind
docs-only classifier, renamed or
skipped required checks, `CODEOWNERS` coverage, a placeholder prebuild hash,
`Package.swift` drifting from the lockfile, and a FileProvider wider than
`captures/`.

`security.android.test.ts` and `security.apple.test.ts` do the same for the
§5 host invariants (Android WebView, handoff, IPC, manifest and backup rules,
the Kotlin API dump; iOS ATS, bootstrap script, handoff, storage, confinement,
permission allowlist, wire parity and the Swift API snapshot; the desktop
host). `error-codes-parity.test.ts` parses the Kotlin and Swift `ErrorCodes`
against `core/messages`.

Extend these when a new invariant can be checked by reading files; prefer a
behavior test next to the code when it cannot.

## Accepted risks

- Per-resource capability tokens are deferred (ADR 0003). Any holder of the
  session can read every gated mount for the session's lifetime.
- The loopback is cleartext. Another process on the device can observe it only
  with privileges that are out of scope.
- Dev mode (`mode=dev`) has no credential, no Fetch-metadata check and no
  nonce. The origin rule still applies, but a non-browser process on the
  machine can drive a dev backend. Never ship it.
- **Gated file mounts inside the public root.** The overlap check covers
  directory mounts only. A gated `mount(path, file)` whose file lies inside the
  public web root is still reachable before login through its public URL (as
  app code). Consumers must keep gated files out of the web app directory.
- **Path races.** The descriptor re-check stops a single symlink swap, but not
  a hard link to a file outside the mount (it is a real file in the mount), nor
  a multi-flip race that swaps the path back between open and re-check. The
  attacker must already write inside a mount root.
- **Gradle next to the release secrets.** `publish-maven` runs the Gradle
  publish tasks, which rebuild the AAR, so Gradle, AGP and their plugins run
  in the job that holds the signing and Sonatype secrets. Dependency
  verification and the wrapper check narrow this; the AAR is not proved
  byte-identical to the one the credential-free build job produced.
- The repository's `release` environment protection and secret scoping are
  settings, not code: `RELEASING.md` says what they must be, and no test can
  see them.
- `createMockTransport` stays in the public `transports` export and ships
  inside the `@ekrooh/bare/transports` bundle (present in a production bundle
  even when unused). It fakes the host (known permissions granted) and only
  warns inside an app shell; the reference app's mode guard keeps it unused in
  production builds.
- **Gated-root cache.** Each gated directory root is resolved once and
  cached; it is re-resolved only on a request to that gated mount. A gated
  root later replaced by a symlink into the web app is therefore not
  re-checked by public-mount requests until its own mount is requested.
- **Required checks are not pinned to the GitHub Actions app** in the `main`
  ruleset, so another app with check-write access could report a required
  check as passing. This is a repository setting the owner handles.
- **Deploy templates**: the signing jobs build the app with the keystore
  present, so build-time dependency code runs next to it.
- Deferred: `examples/vote` has no Android Gradle verification metadata;
  `npm run prebuilds` needs `unzip` (no Windows path). Vendored agent-skill hashes are unverified (no reproducible
  algorithm); the dead Android `libnativehelper.so` stub stays until removal is
  verified on a device; the Android decoder does not resync after a framing
  fault; Android `targetSdk 36` and narrower consumer keep rules.

## Running a review

Use the `security-review` skill (`.agents/skills/security-review/SKILL.md`).
File each finding as a GitHub issue labelled `security` (see
`docs/agents/issue-tracker.md`); report a vulnerability that affects a published
release privately (see `SECURITY.md`) rather than in a public issue.
