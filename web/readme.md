# web/transports/

Transports for the binary message protocol. Exported as `@ekrooh/bare/transports`.

| File                  | Contents                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `index.ts`            | Public entry: `MessageTransport` type + the transports.                                                                |
| `websocket-client.ts` | `createWebSocketTransport` + the `MessageTransport` interface (lives one level up). Same-origin default, cookie login. |
| `mock.ts`             | `createMockTransport` — deterministic, in-process responses used by unit/e2e tests.                                    |
| `mock-handlers.ts`    | Mock invoke handlers for the canonical health plugin.                                                                  |

A `MessageTransport` has `send(type, header, payload?)` and
`subscribe(handler)`. It is the UI-facing boundary; it does not know about
worklets, Bare, or host IPC.

On device the page is served by the worklet's loopback server, so the
WebSocket transport defaults to the page origin (`ws://location.host`); when a
per-session token is injected (`window.__ekrooh.token`) it is exchanged for a
`bare_session` cookie via `POST /login` before the socket opens, and
reconnects with backoff (250ms → 2s, 5 tries). Browser dev is cross-origin, so
pass an explicit URL (`VITE_BARE_WS_URL` in `examples/web`).

Tests: `mock.test.ts` + `websocket-client.test.ts` (run via `vp test`).
