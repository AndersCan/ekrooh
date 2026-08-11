# web/transports/

Transports for the binary message protocol. Exported as `@less/bare/transports`.

| File                            | Contents                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                      | Public entry: `MessageTransport` type + the transports.                                                                |
| `websocket-client.ts`           | `createWebSocketTransport` + the `MessageTransport` interface (lives one level up).                                    |
| `mock.ts`                       | `createMockTransport` — deterministic, in-process responses used by unit/e2e tests.                                    |
| `mock-handlers.ts`              | Mock invoke handlers for the canonical health plugin.                                                                  |
| `bootstrap-bridge.ts`           | `createBootstrapBridgeTransport` — raw framed bytes over a `WebMessagePort` handed over by the embedded WebView shell. |
| `bootstrap-bridge-wkwebview.ts` | `createWkWebViewBridgeTransport` — base64 frames over `WKScriptMessageHandler` + injected `onBareMessage` (iOS).       |

A `MessageTransport` has `send(type, header, payload?)` and
`subscribe(handler)`. It is the UI-facing boundary; it does not know about
worklets, Bare, or host IPC.

Tests: `mock.test.ts` (run via `vp test`).
