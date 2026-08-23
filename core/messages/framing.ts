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

/** Receive-side frame decoder for a single channel. The frozen wire format
 * `[version][type][hLenHi][hLenLo][header][payload]` has no payload-length
 * field, so a frame's end must be derived from the header: `4 + headerLen`
 * for header-only frames, plus the header-carried `payloadLength` (written by
 * {@link MessageProtocol.encode} when a frame carries a payload) otherwise.
 * `push` is fully synchronous: it drains whatever complete frames a chunk
 * completes and leaves partial bytes buffered, so a channel that awaits
 * downstream routing cannot interleave reads/writes on a shared buffer.
 * Framing violations throw after clearing the internal buffer (self-resync);
 * the caller decides whether to drop the channel. Decode errors from
 * {@link MessageProtocol.decode} propagate unchanged. */
export interface FrameDecoder {
  push(chunk: Uint8Array): WireMessage[];
  clear(): void;
  get error(): Error | null;
}

export function createFrameDecoder(protocol: MessageProtocol): FrameDecoder {
  let buffer: Uint8Array = new Uint8Array(0);
  let error: Error | null = null;

  function fail(err: Error): Error {
    error = err;
    buffer = new Uint8Array(0);
    return err;
  }

  /** Reads the header-carried payload length so a payload-bearing frame can be
   * framed end-to-end. Falls back to 0 (header-only framing) when the header
   * is unparseable or the field is absent/garbage — the caller then treats the
   * bytes after the header as the next frame, exactly as the old format did. */
  function declaredPayloadLen(headerLen: number): number {
    if (headerLen === 0) return 0;
    try {
      const headerStr = new TextDecoder().decode(
        buffer.subarray(4, 4 + headerLen),
      );
      const raw = JSON.parse(headerStr) as { payloadLength?: unknown };
      if (
        raw &&
        typeof raw.payloadLength === 'number' &&
        Number.isFinite(raw.payloadLength) &&
        raw.payloadLength >= 0
      ) {
        return raw.payloadLength;
      }
    } catch {
      /* unparseable header — treat as header-only */
    }
    return 0;
  }

  function push(chunk: Uint8Array): WireMessage[] {
    if (error) return [];
    buffer = concatBytes(buffer, chunk);

    const out: WireMessage[] = [];
    while (buffer.byteLength >= 4) {
      const headerLen = (buffer[2] << 8) | buffer[3];
      if (headerLen > MAX_HEADER_BYTES) {
        throw fail(
          new Error(
            `Header too large: ${headerLen} bytes, maximum is ${MAX_HEADER_BYTES}`,
          ),
        );
      }
      const frameLen = 4 + headerLen + declaredPayloadLen(headerLen);
      if (frameLen > protocol.maxFrameBytes) {
        throw fail(
          new Error(
            `Frame too large: ${frameLen} bytes, maximum is ${protocol.maxFrameBytes}`,
          ),
        );
      }
      if (buffer.byteLength < frameLen) break;

      const frame = buffer.subarray(0, frameLen);
      buffer = buffer.subarray(frameLen);
      out.push(protocol.decode(frame));
    }

    // A partial longer than the frame cap can never complete a legal frame.
    if (buffer.byteLength > protocol.maxFrameBytes) {
      throw fail(
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
