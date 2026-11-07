# web/transports/

Transports for the binary message protocol, exported as `@ekrooh/bare/transports`.

- `index.ts`: public entry (`MessageTransport` type and transports).
- `../websocket-client.ts`: `createWebSocketTransport` and the `MessageTransport` interface.
- `mock.ts`: `createMockTransport`, deterministic in-process responses for tests and browser dev. It runs the real plugin kernel and the real `core.health`/`core.discovery`/`core.logs`/`core.permissions` manifests; only the host (known permissions granted, unknown ones `unsupported`) and `vendor.media` (a `data:` image) are stubbed. It warns inside an app shell and must never ship.

`MessageTransport` has `send(type, header, payload?)`, `subscribe(handler)` and an optional `close()`. It knows nothing about worklets, Bare, or host IPC.

WebSocket transport:

- Defaults to the page origin. On device the worklet's loopback server serves the page.
- A one-time nonce (`window.__ekrooh.bootstrap`, never the raw token) is exchanged for a `bare_session_<port>` cookie via `POST /login`.
- Reconnects with equal-jitter backoff (250 ms doubling to 2 s). A never-connected client gives up after 5 retries **and** at least 10 s (`minBootWindowMs`); once connected it retries forever. The retry count resets only after 5 s of stable open; a socket stuck connecting is dropped after 10 s (`openTimeoutMs`).
- Close code 4001 (`"replaced"`: another document took the session) waits 30 s or until foreground before reconnecting. `WAKE` (foreground) retries at once and recovers a client that gave up.
- Sent invokes fail with `TRANSPORT_ERROR` as soon as their socket is lost; at most 256 requests (`maxQueued`) wait while connecting. `close()` ends the transport for good. `diagnostics: true` folds server log lines into the give-up error.
- No `?token=` fallback.
- Cross-origin browser dev needs `VITE_BARE_WS_URL` (see `examples/web`).

Tests: `transports/mock.test.ts`, `transports/mock-parity.test.ts`, `websocket-client.test.ts`, `connection-machine.test.ts` (`vp test`).
