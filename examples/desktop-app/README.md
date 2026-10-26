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

1. The host takes an exclusive lock on `<storage>/ekrooh.lock`. If another
   instance holds it, the launch is a **no-op** (exit 0). The backend inherits
   the lock, so a relaunch cannot race a backend that is still shutting down.
2. It opens the window on a local "Starting" page and spawns
   `bare desktop.bundle webassets=… storage=… cache=… auth=on port=0 handoff=<fd>`,
   keeping the child's **stdin open** and passing it the write end of a private
   pipe.
3. The backend binds an ephemeral loopback port and writes one JSON line,
   `{ origin, bootstrap }`, to that pipe. Nothing is written to disk: the
   session token never leaves the backend (`handoffFile: false`; the mobile
   hosts still read `handoff.json` from their sandbox).
4. The host injects `window.__ekrooh = { bootstrap }` (on the backend's origin
   only) and navigates. The page does `POST /login` itself (ADR 0003); the
   WebSocket + nonce is the only contract.
5. When the window closes the host closes stdin. The backend shuts down on EOF,
   so a crashed host leaves no orphan either; one that ignores EOF for 5s is
   killed.

If the backend fails to start (exits, times out after 20s, or hands off
garbage) or dies while the window is open, the window shows an error page
pointing at `<storage>/backend.log` instead of vanishing, and the host exits 1
when it is closed.

## Build and run

Needs `zig` >= 0.17 (build-time only) and Xcode command line tools.

```sh
npm run build:desktop            # add `-- --skip-web` to reuse the last web build
open examples/desktop-app/dist/Ekrooh.app
# or, with logs and a throwaway data dir:
examples/desktop-app/dist/Ekrooh.app/Contents/MacOS/ekrooh --debug --storage /tmp/ekrooh-dev
```

Host flags: `--resources <dir>`, `--storage <dir>` (default
`~/Library/Application Support/Ekrooh`, created `0700`), `--debug` (webview
devtools; backend output to the terminal instead of `backend.log`).
`zig build test` runs the host unit tests; `npm run smoke:desktop` launches two instances of the built app and checks
the pipe handoff and nonce redemption, the single-instance no-op, surviving a
backend crash, and orphan cleanup (CI job `desktop`).

## Not done yet

- Windows and Linux hosts (`build.zig` panics on non-macOS targets).
- Developer ID signing / notarization (the build ad-hoc signs only).
- Intel macOS is untested.
