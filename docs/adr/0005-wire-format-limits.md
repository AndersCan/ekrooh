# Wire format: keep the JSON-header frame for v1, fail oversized results loudly, move results to the body in the next major

Status: proposed. Needs owner approval before it binds (it touches the wire-protocol boundary in `vision.md`).

## Context

A frame is `[version][type][headerLen(2)][payloadLen(3)][header][payload]`
(`core/messages/wire-codec.ts`, mirrored by `android/.../BareProtocol.kt`,
`FrameDecoder.kt` and `ios/.../BareProtocol.swift`, `FrameDecoder.swift`). The JSON
header carries `args` on requests and `result` on responses, and its length is a
16-bit field, so `MAX_HEADER_BYTES` is 65,535. The payload has a 24-bit length
(frame cap 16 MiB) but only requests use it: `route()` returns a header, and every
response is encoded with a `null` payload.

Measured by reading the code, then confirmed with a throwaway test:

- A result whose JSON exceeds 64 KB makes `encode` throw `Header too large: 70095
  bytes`. Both `core/runtime.ts` and `core/server/websocket-server.ts` catch that
  and only log it. **The caller gets no response and times out.** The limit is
  also unreachable by design: a plugin cannot return a large result at all, so
  `/logs` and similar loopback routes act as side channels.
- The decoder rejects any `version` other than `1`, and the decode allowlist drops
  unknown header fields. A peer on an older build cannot ignore a new field; it
  loses it.
- Per-message cost is not the problem (about 0.5 µs per encode or decode). The
  framing questions here are size, correlation and backpressure, not speed.

Out of scope: the connection layer (O1 to O4) and the choice of transport.

## Options

**(a) Keep the format, document the limit.** No wire change. Results stay under
64 KB; larger data goes through a side channel or the request payload. Cheap, but
leaves the silent-timeout failure unless fixed separately, and keeps the side
channels.

**(b) Results and args in the body behind a small routing header.** The header
shrinks to routing fields (`type`, `pluginId`, `event`, `requestId`, `error`); args
and results ride in the payload as JSON. Removes the 64 KB ceiling (16 MiB frame
cap applies) and lets a response carry a payload. Cost: a new frame layout in
three codecs (TS, Kotlin, Swift) and a version bump. Old peers cannot read it
(version check, allowlist), so it is a **major-version event** unless negotiated
per connection, which adds handshake state we do not have today.

**(c) Adopt `bare-rpc` or `protomux`.** Facts checked against the repos
(`holepunchto/bare-rpc` v1.3.8 at `5afe378`, `holepunchto/protomux` v3.13.0 at
`7baab64`, both read 2026-10-26):

- `bare-rpc`: stream framing with a `uint32` length prefix; compact-encoding
  header with numeric `command` and an incrementing integer request `id` that it
  correlates itself; request data is a binary buffer with no 64 KB cap; supports
  request/response streams with pause/resume flow control; `write()` return value
  and `drain` are honoured. It has **no timeout and no in-flight cap** in
  `index.js`, and routes by number, so `pluginId.event` strings need our own
  registry mapping. Dependencies: `bare-stream`, `compact-encoding`, `b4a`,
  `safety-catch`. It is ABI compatible with `librpc` (C), but Kotlin and Swift
  hosts would need bindings to it, which I did not verify exist.
- `protomux`: multiplexes named protocol channels over a stream that **already
  preserves message boundaries** (its README requires a framed stream). Messages
  are typed with compact-encoding. `send()` returns the `stream.write()` result
  and channels expose `ondrain`; its source has `MAX_BACKLOG = Infinity // TODO`
  for open backpressure. It has **no request/response correlation**, so it fills
  framing and backpressure only.

Neither covers our browser side: the WebView talks plain WebSocket to the worklet,
so adopting either means bundling their stack into the web build and replacing
`wire-codec`, `framing`, `rpc-messenger` and both native decoders at once. That is
also a major-version break, with a larger blast radius than (b) and without the
timeout, cap and `pluginId.event` routing that we already have and just fixed.

## Decision

Recommended:

1. **Now (additive, no wire change): option (a), made safe.** Document the 64 KB
   header limit in `core/messages/readme.md`. When a response cannot be encoded,
   answer with an error response (`FRAME_TOO_LARGE`, already a canonical code)
   instead of dropping it, in both handlers. This removes the silent timeout and
   needs a failing test first. Track as its own item; it is not part of this ADR.
2. **Next major: option (b).** Move args and results into the payload behind a
   routing-only header, bump `VERSION`, and change TS, Kotlin and Swift together.
   Do it only when a major is already planned, not on its own.
3. **Do not adopt (c) as the framing layer.** Borrow ideas instead: `bare-rpc`'s
   pause/resume stream model is a reference for O3 backpressure, and `protomux`'s
   per-channel `ondrain` shows the same shape.

## Consequences

- No immediate breaking change; items 1 and 3 touch no frozen boundary.
- The 64 KB ceiling stays until the next major, so plugins that need more keep using
  loopback routes or payload-bearing requests. Plugin authors should treat it as a
  documented limit.
- Item 2 is gated by the stability contract: a new frame version, a coordinated
  Kotlin and Swift decoder change, and the public-API snapshot update.
- Reopen (c) only if we need cross-app interop with Holepunch peers over the
  IPC leg or a native `librpc` host.
- Not verified: Kotlin or Swift bindings for `librpc`, and `bare-rpc` behaviour in
  the browser, since neither library was run. Only their source and README were read.
