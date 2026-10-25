import { MAX_HEADER_BYTES } from './constants';
import type { WireMessage } from './types';
import type { MessageProtocol } from './wire-codec';

/** Smallest buffer allocated for a partial frame whose length is not yet known
 * (fewer than 7 prefix bytes have arrived). */
const MIN_PARTIAL_BYTES = 64;

/** A partial-frame buffer larger than this is released once drained, so one
 * large frame does not pin its memory for the rest of the session. */
const RETAIN_BYTES = 64 * 1024;

/** Receive-side frame decoder for a single channel. The wire format is
 * `[version][type][hLenHi][hLenLo][pLenHi][pLenMid][pLenLo][header][payload]`:
 * bytes 2-3 carry the 16-bit header length and bytes 4-6 a 24-bit payload
 * length (written by {@link MessageProtocol.encode}), so a frame's end is
 * exactly `7 + headerLen + payloadLen`. The binary prefix is the frame boundary
 * source of truth — a peer that re-serializes the JSON header (dropping
 * unknown fields) cannot touch these bytes. `push` is fully synchronous: it
 * drains whatever complete frames a chunk completes and leaves partial bytes
 * buffered, so a channel that awaits downstream routing cannot interleave
 * reads/writes on a shared buffer. A frame-level failure (a framing violation
 * or a decode error from {@link MessageProtocol.decode}) marks the decoder
 * inert — clearing the internal buffer so a corrupt byte stream self-resyncs —
 * but the frames already decoded from the same chunk are still returned; the
 * caller decides whether to drop the channel. The caller checks `error` after a
 * `push` rather than relying on a throw, so a good frame is never lost to a
 * later frame failing in the same chunk.
 *
 * Reassembly is linear in the bytes received: once the length prefix of an
 * incomplete frame is known the partial buffer is sized to that frame once and
 * filled in place as chunks arrive, rather than re-concatenating everything
 * buffered on every chunk. */
export interface FrameDecoder {
  push(chunk: Uint8Array): WireMessage[];
  clear(): void;
  get error(): Error | null;
}

export function createFrameDecoder(protocol: MessageProtocol): FrameDecoder {
  /** Partial-frame storage: the first `length` bytes are buffered data. Empty
   * whenever nothing is buffered, so a chunk of whole frames is decoded
   * straight from the caller's bytes without being copied in first. */
  let buffer: Uint8Array = new Uint8Array(0);
  let length = 0;
  let error: Error | null = null;

  function fail(err: Error): void {
    error = err;
    // Drop everything buffered: a corrupt byte in the pending partial desyncs
    // the stream, so the only safe resync point is a fresh frame boundary after
    // `clear()` (or a successful batch, which resets the error).
    buffer = new Uint8Array(0);
    length = 0;
  }

  /** Grows `buffer` to hold at least `bytes`, preserving buffered data. */
  function reserve(bytes: number): void {
    if (buffer.byteLength >= bytes) return;
    const next = new Uint8Array(Math.max(bytes, MIN_PARTIAL_BYTES));
    next.set(buffer.subarray(0, length), 0);
    buffer = next;
  }

  /** Keeps `rest` (the unconsumed tail of `source`) as the buffered partial,
   * sized for `frameLen` when the incomplete frame's length is known. */
  function retain(
    source: Uint8Array,
    from: number,
    to: number,
    frameLen: number,
  ) {
    const rest = to - from;
    if (rest === 0) {
      length = 0;
      if (buffer.byteLength > RETAIN_BYTES) buffer = new Uint8Array(0);
      return;
    }
    if (source === buffer) {
      // Compact in place; `copyWithin` handles the overlap.
      buffer.copyWithin(0, from, to);
      length = rest;
      reserve(frameLen);
      return;
    }
    // `source` is the caller's chunk, which they may reuse: copy the tail out.
    length = 0;
    reserve(Math.max(rest, frameLen));
    buffer.set(source.subarray(from, to), 0);
    length = rest;
  }

  function push(chunk: Uint8Array): WireMessage[] {
    if (error) return [];

    let source: Uint8Array;
    let end: number;
    if (length === 0) {
      // Nothing buffered: decode straight from the caller's bytes.
      source = chunk;
      end = chunk.byteLength;
    } else {
      reserve(length + chunk.byteLength);
      buffer.set(chunk, length);
      length += chunk.byteLength;
      source = buffer;
      end = length;
    }

    const out: WireMessage[] = [];
    let offset = 0;
    // Length of the incomplete frame at `offset`, once its prefix has arrived.
    let pendingFrameLen = 0;
    while (end - offset >= 7) {
      const headerLen = (source[offset + 2] << 8) | source[offset + 3];
      if (headerLen > MAX_HEADER_BYTES) {
        fail(
          new Error(
            `Header too large: ${headerLen} bytes, maximum is ${MAX_HEADER_BYTES}`,
          ),
        );
        return out;
      }
      const payloadLen =
        (source[offset + 4] << 16) |
        (source[offset + 5] << 8) |
        source[offset + 6];
      const frameLen = 7 + headerLen + payloadLen;
      if (frameLen > protocol.maxFrameBytes) {
        fail(
          new Error(
            `Frame too large: ${frameLen} bytes, maximum is ${protocol.maxFrameBytes}`,
          ),
        );
        return out;
      }
      if (end - offset < frameLen) {
        pendingFrameLen = frameLen;
        break;
      }

      // Copy the frame out before decoding: `source` may be the caller's chunk
      // (or the reusable partial buffer), so a `subarray` view would let
      // `decode`'s header/payload views point back at memory that is reused on
      // the next read — silently corrupting decoded data.
      // `Uint8Array.prototype.slice` is called explicitly: on a Node/Bare
      // `Buffer`, `.slice` is a view, not a copy.
      const frame = Uint8Array.prototype.slice.call(
        source,
        offset,
        offset + frameLen,
      );
      offset += frameLen;
      try {
        out.push(protocol.decode(frame));
      } catch (err) {
        // A successfully-buffered frame whose header/payload content is
        // malformed must not discard the frames decoded before it in the same
        // chunk. Return them, mark the channel inert, and stop: the byte stream
        // is no longer trustworthy past this boundary.
        fail(err instanceof Error ? err : new Error(String(err)));
        return out;
      }
    }

    retain(source, offset, end, pendingFrameLen);

    // A partial longer than the frame cap can never complete a legal frame.
    if (length > protocol.maxFrameBytes) {
      fail(
        new Error(
          `Frame buffer exceeded ${protocol.maxFrameBytes} bytes with no complete frame`,
        ),
      );
    }

    return out;
  }

  return {
    push,
    clear() {
      buffer = new Uint8Array(0);
      length = 0;
      error = null;
    },
    get error() {
      return error;
    },
  };
}
