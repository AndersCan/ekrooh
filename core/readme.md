# core/

The Bare worklet side of the framework.

| Path           | Contents                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages/`    | **Public API.** Binary wire protocol (`MessageProtocol`), plugin registry/router, RPC messenger, host IPC bridge, shared types. See `messages/readme.md`. |
| `server/`      | Dev WebSocket backend (`websocket-server.ts`), used by `npm run dev`.                                                                                     |
| `lib/`         | `get-ipc.ts` — resolves the active IPC channel (BareKit / Sidecar).                                                                                       |
| `main.core.ts` | Worklet entry: wires plugins, host bridge, IPC, and the dev server. Bundled by `npm run build:core` into `core/main.core.gen.js` (build output).          |

Stability note: `messages/` is exported as `@ekrooh/bare/core` and is part of the
public API contract (see `vision.md`). The rest is implementation.

Tests: co-located `*.test.ts` (run via `vp test`).
