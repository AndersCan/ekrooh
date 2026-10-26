# Desktop reference app (macOS)

A thin native launcher around the same Bare backend and web UI the mobile apps
use. The result runs with **no Node, Bun or other runtime installed**.

```
Ekrooh.app/Contents
  MacOS/ekrooh                Zig host (this directory) + webview/webview
  Resources/bare              sidecar Bare runtime
  Resources/desktop.bundle    packed backend (core/desktop.core.ts)
  Resources/node_modules/     native addons (udx, sodium, rocksdb, ...)
  Resources/WebAssets/        the reference web build
```

## How it works

1. The host spawns `bare desktop.bundle webassets=… storage=… cache=… auth=on port=0`
   and keeps the child's **stdin open**.
2. The backend binds an ephemeral loopback port and writes `handoff.json`
   (origin + one-time `bootstrap` nonce) into the storage dir, as on mobile.
3. The host reads it, injects `window.__ekrooh = { bootstrap }` and opens a
   native webview on the origin. The page does `POST /login` itself
   (ADR 0003); the WebSocket + nonce is the only contract.
4. When the window closes the host closes stdin. The backend exits on EOF, so a
   crashed host leaves no orphan either.

## Build and run

Needs `zig` >= 0.17 (build-time only) and Xcode command line tools.

```sh
npm run build:desktop            # add `-- --skip-web` to reuse the last web build
open examples/desktop-app/dist/Ekrooh.app
# or, with logs and a throwaway data dir:
examples/desktop-app/dist/Ekrooh.app/Contents/MacOS/ekrooh --debug --storage /tmp/ekrooh-dev
```

Host flags: `--resources <dir>`, `--storage <dir>` (default
`~/Library/Application Support/Ekrooh`), `--debug` (webview devtools).
`zig build test` runs the host unit tests; `npm run smoke:desktop` launches two instances of the built app and checks the nonce handoff and orphan cleanup (CI job `desktop`).

## Not done yet

- Windows and Linux hosts (`build.zig` panics on non-macOS targets).
- Developer ID signing / notarization (the build ad-hoc signs only).
- Intel macOS is untested.
