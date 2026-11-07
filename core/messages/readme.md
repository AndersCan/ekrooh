# core/messages

Wire protocol, codec, and plugin helpers. Exported as `@ekrooh/bare/core`.

## Envelope

`version` (1 B), `type` (1 B), `headerLen` (2 B, big-endian), `payloadLen` (3 B, big-endian), `header` (`headerLen` B of UTF-8 JSON), `payload` (`payloadLen` B).

Decode is an allowlist: each header type is rebuilt from its known fields, unknown fields are dropped, `args`/`result` are rebuilt without a prototype (`__proto__`, `constructor`, `prototype` removed), and `pluginId`/`event`/`requestId` are at most 256 UTF-8 bytes. An undecodable host capabilities answer fails the capability query with `FRAME_INVALID`. Invalid UTF-8 or JSON is `FRAME_INVALID`. A content-invalid frame is skipped on its own (an `INVOKE_REQUEST` among them is answered `FRAME_INVALID`); a framing violation closes the WebSocket.

- Header is capped at 64 KiB; oversize fails with `FRAME_TOO_LARGE`, never truncated.
- Frame is capped at 16 MiB. Move large binaries out of band: pass a path or handle in the header, send bytes over HTTP or a file URL.
- Limits are mirrored in `android/.../BareProtocol.kt` and `ios/Sources/BareHost/BareProtocol.swift`.

`MessageProtocol` (`wire-codec.ts`) is the source of truth for encode, decode, version and type checks, and frame-size checks. Call it directly. Headers: `DISPATCH`, `INVOKE_REQUEST`, `INVOKE_RESPONSE`; every invoke response echoes `requestId`.

## Results and errors

- Return `ok(result)` (`[null, result]`) or `err(code, message)` (`[error, null]`) from `errors.ts`.
- Use canonical `ErrorCode` values from `constants.ts`. Keep `android/.../ErrorCodes.kt` and `ios/Sources/BareHost/ErrorCodes.swift` in sync.
- App-scoped codes (e.g. `app.photos/not-found`) pass through verbatim.
- The router synthesizes `UNSUPPORTED_EVENT` (also for a declared event with no handler) and answers an adapter throw as `PLUGIN_ERROR` with a fixed message (`<pluginId>.<event> failed`); the exception text is logged, never sent. Use `err(code, message)` to send a specific message.
- Host error codes outside the canonical set and the app-scoped form (`ns.x/code`, at most 64 characters) become `HOST_ERROR`; host messages are capped at 512 characters. A host that misses its deadline is `TIMEOUT`.

## Plugin authoring

1. Namespaced ID (`app.plugin`: two or more dot-separated segments). `core.*` and `vendor.*` are reserved for the framework's plugins; `registry.register` throws on a reserved or malformed id.
2. One typed `EventSpec` per event; `definePlugin` (`define-plugin.ts`) builds the manifest and handler table.
3. Call through `invokeEvent` / `dispatchEvent` (same file).
4. `dispatch` for side effects, `invoke` for request/response.
5. Return `UNSUPPORTED_CAPABILITY` or `UNSUPPORTED_EVENT` when a runtime cannot handle an event.
6. `args` is untrusted: it is a compile-time type only. Give the spec a `validate(args)` hook (failing args are answered `PLUGIN_ERROR` before the handler runs) or check every argument the handler uses.
7. A host-delegated, user-mediated event sets `hostTimeoutMs` on its spec (default host deadline 30 s), plus a matching page-side `timeoutMs`.

## Limits

The router caps calls at `maxInflight` (64) and at three quarters of that per channel (`maxInflightPerChannel`). A per-plugin cap is off by default (`maxInflightPerPlugin` defaults to `maxInflight`). Over a cap is `TRANSPORT_ERROR`. Timer delays are capped at 2^31−1 ms.
