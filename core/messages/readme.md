# Messages and Plugins

## Binary Envelope

- `version`: 1 byte
- `type`: 1 byte
- `headerLen`: 2 bytes (big-endian)
- `header`: UTF-8 JSON
- `payload`: remaining bytes

Limits (mirrored in `android/.../BareProtocol.kt`):

- Header JSON must fit `MAX_HEADER_BYTES` (64 KiB). Oversized headers are a
  `FRAME_TOO_LARGE` error, never silently truncated.
- One frame is capped at `MAX_FRAME_BYTES` (16 MiB by default). Large binary
  transfers belong in a plugin: pass a path/handle/token in the header and move
  bytes out-of-band (HTTP/file URL) where the runtime supports it.

Unknown header fields pass through decode untouched, so forward-compatible
peers can relay envelopes without losing data.

## Canonical Codec

`MessageProtocol` in `core/messages` (implemented in `wire-codec.ts`) is the source of truth for:

- encoding and decoding
- version checks
- message-type checks
- frame-size checks
- request/response header parsing

Use `MessageProtocol` directly from runtime call sites.

## Plugin Headers

- `DISPATCH`
- `INVOKE_REQUEST`
- `INVOKE_RESPONSE`

All invoke responses must echo `requestId`.

## Invoke Result Shape

- Use tuple `Either` everywhere, via the shared helpers `ok(result)` and
  `err(code, message)` (`core/messages/errors.ts`):
  - success: `ok(result)` → `[null, result]`
  - failure: `err(code, message)` → `[error, null]`
- Use canonical `ErrorCode` values (`UNSUPPORTED_CAPABILITY`,
  `UNSUPPORTED_EVENT`, `HOST_ERROR`, `PLUGIN_ERROR`, `TRANSPORT_ERROR`,
  `INVALID_RESPONSE`, `FRAME_TOO_LARGE`, ...). `CoreError.code` narrows on the
  `ErrorCode` union; keep `android/.../ErrorCodes.kt` in sync.
- The router synthesizes `UNSUPPORTED_EVENT` for events not declared in the
  plugin manifest, and wraps adapter exceptions as `PLUGIN_ERROR` — plugins do
  not need to hand-roll either.

## Plugin Authoring Checklist

1. Pick a namespaced plugin ID (`vendor.plugin`).
2. Declare one typed `EventSpec` per event (`definePlugin` builds the manifest
   and the handler table from it; typed `invokeEvent`/`dispatchEvent` builders
   wrap the same specs in `events.ts`).
3. Add runtime adapters (`web`, `android`, `ios`, `bare`).
4. Use `dispatch` for side effects; `invoke` for request/response flows.
5. Return deterministic errors (`UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_EVENT`) when a runtime cannot handle an event.
