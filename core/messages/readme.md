# core/messages

Wire protocol, codec, and plugin helpers. Exported as `@ekrooh/bare/core`.

## Envelope

`version` (1 B), `type` (1 B), `headerLen` (2 B, big-endian), `header` (UTF-8 JSON), `payload` (rest). Unknown header fields pass through decode untouched.

- Header is capped at 64 KiB; oversize fails with `FRAME_TOO_LARGE`, never truncated.
- Frame is capped at 16 MiB. Move large binaries out of band: pass a path or handle in the header, send bytes over HTTP or a file URL.
- Limits are mirrored in `android/.../BareProtocol.kt`.

`MessageProtocol` (`wire-codec.ts`) is the source of truth for encode, decode, version and type checks, and frame-size checks. Call it directly. Headers: `DISPATCH`, `INVOKE_REQUEST`, `INVOKE_RESPONSE`; every invoke response echoes `requestId`.

## Results and errors

- Return `ok(result)` (`[null, result]`) or `err(code, message)` (`[error, null]`) from `errors.ts`.
- Use canonical `ErrorCode` values from `constants.ts`. Keep `android/.../ErrorCodes.kt` and `ios/Sources/BareHost/ErrorCodes.swift` in sync.
- App-scoped codes (e.g. `app.photos/not-found`) pass through verbatim.
- The router synthesizes `UNSUPPORTED_EVENT` and wraps adapter throws as `PLUGIN_ERROR`.

## Plugin authoring

1. Namespaced ID (`vendor.plugin`).
2. One typed `EventSpec` per event; `definePlugin` (`define-plugin.ts`) builds the manifest and handler table.
3. Call through `invokeEvent` / `dispatchEvent` (same file).
4. `dispatch` for side effects, `invoke` for request/response.
5. Return `UNSUPPORTED_CAPABILITY` or `UNSUPPORTED_EVENT` when a runtime cannot handle an event.
