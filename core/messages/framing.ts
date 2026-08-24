import { MAX_HEADER_BYTES } from './constants';
import type { WireMessage } from './types';
import type { MessageProtocol } from './wire-codec';

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

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
 * later frame failing in the same chunk. */
export interface FrameDecoder {
  push(chunk: Uint8Array): WireMessage[];
  clear(): void;
  get error(): Error | null;
}

export function createFrameDecoder(protocol: MessageProtocol): FrameDecoder {
  let buffer: Uint8Array = new Uint8Array(0);
  let error: Error | null = null;

  function fail(err: Error): void {
    error = err;
    // Drop everything buffered: a corrupt byte in the pending partial desyncs
    // the stream, so the only safe resync point is a fresh frame boundary after
    // `clear()` (or a successful batch, which resets the error).
    buffer = new Uint8Array(0);
  }

  function push(chunk: Uint8Array): WireMessage[] {
    if (error) return [];
    buffer = concatBytes(buffer, chunk);

    const out: WireMessage[] = [];
    while (buffer.byteLength >= 7) {
      const headerLen = (buffer[2] << 8) | buffer[3];
      if (headerLen > MAX_HEADER_BYTES) {
        fail(
          new Error(
            `Header too large: ${headerLen} bytes, maximum is ${MAX_HEADER_BYTES}`,
          ),
        );
        return out;
      }
      const payloadLen = (buffer[4] << 16) | (buffer[5] << 8) | buffer[6];
      const frameLen = 7 + headerLen + payloadLen;
      if (frameLen > protocol.maxFrameBytes) {
        fail(
          new Error(
            `Frame too large: ${frameLen} bytes, maximum is ${protocol.maxFrameBytes}`,
          ),
        );
        return out;
      }
      if (buffer.byteLength < frameLen) break;

      // Copy the frame out of the internal buffer before decoding: `buffer`
      // may alias the caller-supplied `chunk` (concatBytes returns `chunk`
      // directly when the buffer was empty), so a `subarray` view would let
      // `decode`'s header/payload views point back at caller-owned memory that
      // the caller reuses on its next read — silently corrupting decoded data.
      const frame = buffer.slice(0, frameLen);
      buffer = buffer.subarray(frameLen);
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

    // A partial longer than the frame cap can never complete a legal frame.
    if (buffer.byteLength > protocol.maxFrameBytes) {
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
      error = null;
    },
    get error() {
      return error;
    },
  };
}
