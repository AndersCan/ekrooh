# core/

Bare worklet side of the framework.

| Path           | Contents                                                                |
| -------------- | ----------------------------------------------------------------------- |
| `messages/`    | Public API (`@ekrooh/bare/core`): wire protocol, router, RPC, host IPC. |
| `server/`      | Dev WebSocket backend (`websocket-server.ts`) used by `npm run dev`.    |
| `lib/`         | `get-ipc.ts`: resolves the IPC channel (BareKit / Sidecar).             |
| `main.core.ts` | Worklet entry. `npm run build:core` bundles it to `main.core.gen.js`.   |

Only `messages/` is public API (see `messages/readme.md` and `vision.md`).

Tests: co-located `*.test.ts`, run with `vp test`.
