# @ekrooh/bare

**One soul, many platforms.** One codebase and identity across Android, iOS,
web, and desktop.

**Docs: <https://anderscan.github.io/ekrooh>**

[![CI](https://github.com/AndersCan/ekrooh/actions/workflows/test.yml/badge.svg)](https://github.com/AndersCan/ekrooh/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/AndersCan/ekrooh)](https://github.com/AndersCan/ekrooh/releases/latest)

The boring bootstrap for cross-platform apps on the Bare runtime (holepunch): a
binary wire protocol, plugin kernel, RPC messenger, transports, and native host
bridges, plus a reference app.

- [`vision.md`](vision.md): what this project is and is not.
- [`AGENTS.md`](AGENTS.md): how to develop it and the canonical commands.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to contribute.
- [`RELEASING.md`](RELEASING.md): how to cut a release.
- `docs/`: internal ADRs (`docs/adr/`) and agent operations; not the public site.

## Model

The frontend (browser or WebView) is written as if only a backend is reachable
over a WebSocket carrying binary framed messages.

- On device, the worklet runs one loopback HTTP+WS server that serves the web
  app, media files, and the protocol socket. The page connects to
  `ws://location.host`.
- `VITE_TRANSPORT_MODE=mock` selects the mock transport (tests).
- Browser dev points the WebSocket at the dev backend via `VITE_BARE_WS_URL`.

The UI never branches on worklets, Bare, or host IPC. `@ekrooh/bare/core`
describes the wire protocol, not the runtime that implements it.

| Term         | Meaning                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **Frontend** | Web UI: Vite bundle in the browser, or the same bundle in a WebView.                             |
| **Backend**  | Runs the core bundle and speaks the framed protocol with the frontend.                           |
| **Host**     | Native shell (Android/iOS): starts the backend, owns system APIs, injects the session bootstrap. |

## Repository layout

- `core/`: wire codec, plugin router, RPC messenger, host IPC (`core/messages`),
  loopback server (`core/server`), worklet entry (`core/main.core.ts`).
- `plugins/`: canonical plugins (`core.health`, `core.discovery`,
  `core.permissions`, `vendor.media`) and typed event builders.
- `web/transports/`: `MessageTransport`, WebSocket and mock transports.
- `android/`: host library `:bare-host` (IPC coordinator, plugin registry, WebView client).
- `ios/`: host Swift package `BareHost` (root `Package.swift`).
- `examples/`: `web/`, `android-app/`, `ios-app/`, `consumer-basic/`.
- `e2e/`: Playwright specs on the mock transport. `scripts/`: dev runner, Playwright wrapper, prebuild fetcher.
- `apps/docs/`: public docs site (Astro Starlight, GitHub Pages).
- `templates/`, `research/`: shared deploy templates; design notes.
- `prebuilds/`: Bare Kit prebuilds (gitignored build output).

The public surface is the `exports` map in `package.json` (`@ekrooh/bare/core`,
`/runtime`, `/plugins`, `/plugins/*/events`, `/transports`). It points at
compiled ESM and type declarations in `dist/` (built with `vp pack`). Consumers
never see TypeScript source.

## Support matrix

| Runtime        | Status                         | Transport | Notes                                                                                           |
| -------------- | ------------------------------ | --------- | ----------------------------------------------------------------------------------------------- |
| Browser (dev)  | first-class                    | WebSocket | Vite + local backend (`VITE_BARE_WS_URL`)                                                       |
| Browser (test) | first-class                    | Mock      | Deterministic Playwright runs                                                                   |
| Android        | first-class                    | WebSocket | Same-origin loopback socket, cookie auth                                                        |
| iOS            | first-class (reference parity) | WebSocket | Same-origin loopback socket, cookie auth; host ships as source (`ios/`, SPM) on the release tag |
| Desktop        | reference (macOS)              | WebSocket | Zig host + system webview + sidecar `bare`; see `examples/desktop-app`                          |

Parity policy: core protocol and plugin contracts are runtime-agnostic.
Capabilities are opt-in plugins and may be runtime-specific. Plugins report
unsupported behavior with deterministic errors. Feature code calls plugin
events, never raw platform APIs.

## Message protocol

Binary frame: `version` (1 byte), `type` (1 byte), `headerLen` (2 bytes, BE),
`payloadLen` (3 bytes, BE), `header` (UTF-8 JSON), `payload` (optional).
Implemented by `MessageProtocol` in `core/messages` (`wire-codec.ts`).

Header types: `DISPATCH`, `INVOKE_REQUEST`, `INVOKE_RESPONSE` (responses echo
`requestId`). `dispatch` is fire-and-forget; `invoke` is request/response and
timeout-bound.

## Plugins

Core ships no product features. Plugin IDs are `vendor.plugin`; events are
plugin-local (`health.ping`). Runtime adapters: `web`, `android`, `ios`, `bare`.
Canonical plugins are listed under Repository layout.

Media never crosses the wire (frame cap 16 MiB). `vendor.media` is the reference
for out-of-band bytes: the host picks or captures a file natively, the worklet
mounts it on the loopback server and returns a URL, and the web layer loads that
URL with cookie auth.

## Loopback server and auth

One server (`core/server/static-file-server.ts`) serves the web app at `/`, plugin
media mounts, and the WebSocket upgrade. On device it binds `127.0.0.1` on an
ephemeral port. Every request is gated by a per-session token:

1. The shell injects `window.__ekrooh = { bootstrap }`, a single-use nonce (never the raw token).
2. The page calls `POST /login` with the nonce and receives a
   `bare_session_<port>` cookie (`HttpOnly; SameSite=Strict; Path=/`). The port
   in the name keeps two loopback servers in one cookie store apart. The raw
   token is never a login credential.
3. The cookie authorizes `<img>`, `<video>`, `fetch`, and the WS upgrade.
   Non-browser clients send `X-Bare-Token`. There is no `?token=` fallback
   (see `docs/adr/0003-loopback-auth-surface.md`).

Only the bootstrap mount at `/` is public pre-auth. The worklet writes
`{ origin, port, bootstrap }` to `handoff.json` in the host's sandbox dir (never
the session token); the host loads `http://127.0.0.1:<port>/index.html` and
deletes the file.

Every request must also target the bound loopback server (`Host`), and a page
`Origin` must be that server or an explicitly allowed one, in every mode.

The dev backend (`mode=dev`) runs the same bundle with auth off on
`ws://localhost:8080`, allowing the Vite dev origin (`origin=` tokens).

## Testing

- Unit: vitest (`vp test`) for the codec, router, RPC messenger, transports;
  JUnit for the Kotlin host; XCTest for the Swift host.
- Type check: `tsc --noEmit`, part of `vp check`.
- Integration: Playwright e2e on the mock transport (`npm run test:e2e:web`).
  Browsers resolve through `scripts/playwright-local-browsers.mjs` into `.playwright-browsers/`.
- Native: `npm run test:ios` runs the Swift XCTest suite and a UI test on the simulator.

## Commands

Canonical list: [`AGENTS.md`](AGENTS.md#canonical-commands). Common ones:

| Command                      | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `vp check`                   | Format, lint, type-check                           |
| `vp test`                    | Unit tests                                         |
| `npm run test`               | Unit + Playwright e2e                              |
| `npm run dev`                | Vite dev server + Bare backend (watch restart)     |
| `npm run dev:mock`           | Vite with mock transport                           |
| `npm run build:core`         | Bundle `core/main.core.ts` (esbuild)               |
| `npm run build:web`          | Build `examples/web` into the Android app's assets |
| `npm run build:ios`          | iOS inputs (addons, bundle, web assets, xcodegen)  |
| `npm run prebuilds`          | Fetch Bare Kit prebuilds (requires `gh`)           |
| `npm run playwright:install` | Download Chromium into `.playwright-browsers/`     |
| `npm run smoke:loopback`     | Smoke-test the loopback server under `bare`        |

## Android build

Needs the Android SDK (`local.properties` with `sdk.dir=...`) and Bare Kit prebuilds.

```bash
vp install
npm run prebuilds
npm run build       # core bundle + web assets
./gradlew :examples:android-app:assembleDebug
```

`./gradlew build` also runs the host library's JUnit tests.

### Consuming the published AAR

`io.github.anderscan.ekrooh:bare-host` is on Maven Central (no credentials).
Pin it to the same version as `@ekrooh/bare`:

```gradle
dependencies {
  implementation "io.github.anderscan.ekrooh:bare-host:<version>"
}
```

GitHub Packages is a fallback that requires a `read:packages` token. Prefer Maven Central.

## iOS build

Needs Xcode, Bare Kit prebuilds, and `xcodegen`.

```bash
vp install
npm run prebuilds   # also fetches prebuilds/ios/BareKit.xcframework
npm run build:ios
npm run test:ios
```

## Notes

- Treat `examples/android-app/src/main/assets/` as build output. Vite clears
  hashed `assets/main-*.{js,css}` before rebuilding.
