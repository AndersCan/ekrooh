# Messages and Plugins

## Binary Envelope

- `version`: 1 byte
- `type`: 1 byte
- `headerLen`: 2 bytes (big-endian)
- `header`: UTF-8 JSON
- `payload`: remaining bytes

## Canonical Codec

`MessageProtocol` in `core/messages` (implemented in `wire-codec.ts`) is the source of truth for:

- encoding and decoding
- version checks
- message-type checks
- request/response header parsing

Use `MessageProtocol` directly from runtime call sites.

## Plugin Headers

- `DISPATCH`
- `INVOKE_REQUEST`
- `INVOKE_RESPONSE`

All invoke responses must echo `requestId`.

## Invoke Result Shape

- Use tuple `Either` everywhere:
  - success: `[null, result]`
  - failure: `[error, null]`
- Core/runtime failures should use `CoreError`.

## Plugin Authoring Checklist

1. Pick a namespaced plugin ID (`vendor.plugin`).
2. Define events and capabilities in `PluginManifest`.
3. Add runtime adapters (`web`, `android`, `ios`, `bare`).
4. Use `dispatch` for side effects; `invoke` for request/response flows.
5. Return deterministic errors (`UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_EVENT`) when a runtime cannot handle an event.
