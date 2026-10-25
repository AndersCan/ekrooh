# web/transports/

Transports for the binary message protocol, exported as `@ekrooh/bare/transports`.

- `index.ts`: public entry (`MessageTransport` type and transports).
- `../websocket-client.ts`: `createWebSocketTransport` and the `MessageTransport` interface.
- `mock.ts`: `createMockTransport`, deterministic in-process responses for tests.
- `mock-handlers.ts`: mock invoke handlers for `core.health`.

`MessageTransport` has `send(type, header, payload?)` and `subscribe(handler)`. It knows nothing about worklets, Bare, or host IPC.

WebSocket transport:

- Defaults to the page origin. On device the worklet's loopback server serves the page.
- A one-time nonce (`window.__ekrooh.bootstrap`, never the raw token) is exchanged for a `bare_session` cookie via `POST /login`.
- Reconnects with backoff (250 ms to 2 s, 5 tries). No `?token=` fallback.
- Cross-origin browser dev needs `VITE_BARE_WS_URL` (see `examples/web`).

Tests: `mock.test.ts`, `websocket-client.test.ts` (`vp test`).
