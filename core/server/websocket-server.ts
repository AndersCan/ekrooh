import { MessageType } from '../messages';
import { BareRuntimeContext } from '../messages/create-bare-runtime-context';
import type { MessageHeader, MessageProtocol } from '../messages';
import type { LoopbackServer } from './static-file-server';

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('Expected Uint8Array or ArrayBuffer from socket data');
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** Envelope encoder bound to a loopback server's connected protocol socket —
 * the server-initiated (backend → web) push seam. */
export type LoopbackPush = (
  header: MessageHeader,
  payload?: Uint8Array | ArrayBuffer | null,
) => boolean;

/** Builds the push seam for the server's connected protocol socket: encodes a
 * `DISPATCH`-style envelope and writes it, mirroring how `attachWebSocketProtocol`
 * writes responses. Returns false when no socket is connected. */
export function createLoopbackPush(
  server: LoopbackServer,
  protocol: MessageProtocol,
): LoopbackPush {
  return (header, payload = null) => {
    const frame = protocol.encode(MessageType.ENVELOPE, header, payload);
    return server.push(frame);
  };
}

/**
 * Attaches the framed-protocol socket to the unified loopback server. The
 * server owns the WebSocket upgrade (origin check, cookie/token auth, single
 * client, idle timeout); this layer only routes decoded envelopes through the
 * plugin router and writes responses back as raw frames.
 */
export function attachWebSocketProtocol(
  server: LoopbackServer,
  context: BareRuntimeContext,
) {
  const { protocol, pluginRouter } = context;

  server.onConnection((socket, _request) => {
    // [f2] instrumentation: confirm whether each health-check request (esp.
    // roundtrip) reaches the worklet and whether a response is emitted.
    console.error('[f2][worklet] connection accepted');
    // Per-socket receive buffer: a single frame may arrive split across several
    // TCP segments, or several frames may arrive coalesced into one chunk. The
    // wire format is `[version][type][headerLen hi][headerLen lo][header][payload]`
    // with the client→server (invoke) direction carrying its arguments in the
    // JSON header and a zero-length payload, so a frame's length is
    // `4 + headerLen` from bytes 2-3. Buffer frames until complete, drain them
    // in order, and leave partial bytes for the next chunk.
    let buffer: Uint8Array = new Uint8Array(0);

    socket.on('data', async (raw) => {
      const data = toUint8Array(raw);
      // [f2] raw byte-count at the very top, before any decode, so we can tell
      // whether the roundtrip INVOKE_REQUEST frame even reaches the worklet
      // (discovery/Ping/Payload requests do; roundtrip's may be dropped on the
      // webview→worklet leg on iOS).
      console.error(`[f2][worklet] on('data') bytes=${data.byteLength}`);
      try {
        if (data.byteLength === 0) return;

        buffer = concatBytes(buffer, data);

        while (buffer.byteLength >= 4) {
          const headerLen = (buffer[2] << 8) | buffer[3];
          if (buffer.byteLength < 4 + headerLen) break;

          // The header carries `payloadLength` (written by
          // MessageProtocol.encode), so a frame is self-delimiting even when
          // coalesced with the next frame in one chunk. Without it the parser
          // leaves the payload bytes trailing and desyncs the following frame —
          // this is the iOS health-check roundtrip failure (ekrooh#115): the
          // payload-bearing payloadEcho request poisoned the next frame.
          let payloadLen = 0;
          try {
            const headerObj = JSON.parse(
              new TextDecoder().decode(buffer.subarray(4, 4 + headerLen)),
            ) as { payloadLength?: number };
            if (typeof headerObj.payloadLength === 'number') {
              payloadLen = headerObj.payloadLength;
            }
          } catch {
            // Malformed header: keep payloadLen at 0; decode() below rejects it
            // and the frame is still consumed so parsing can't loop forever.
          }

          const frameLen = 4 + headerLen + payloadLen;
          // [f2] frame analysis: what the buffered bytes claim (headerLen /
          // payloadLen) vs what actually arrived. If status=PARTIAL the request
          // frame is incomplete on the wire (request-leg drop). If COMPLETE but
          // no recv/emit follows, decode or route threw.
          const status = buffer.byteLength >= frameLen ? 'COMPLETE' : 'PARTIAL';
          const head = Array.from(
            buffer.subarray(0, Math.min(32, buffer.byteLength)),
          )
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
          console.error(
            `[f2][worklet] frame bufLen=${buffer.byteLength} headerLen=${headerLen} payloadLen=${payloadLen} frameLen=${frameLen} status=${status} head=${head}`,
          );
          if (buffer.byteLength < frameLen) break;

          const frame = buffer.subarray(0, frameLen);
          buffer = buffer.subarray(frameLen);

          const parsed = protocol.decode(frame);
          const header = parsed.header;
          console.error(
            `[f2][worklet] recv type=${header.type} event=${'event' in header ? header.event : '-'} requestId=${header.requestId} payloadLen=${parsed.payload.byteLength}`,
          );

          const pluginResponse = await pluginRouter.route(
            header,
            parsed.payload,
          );
          if (pluginResponse) {
            const outFrame = protocol.encode(
              MessageType.ENVELOPE,
              pluginResponse,
              null,
            );
            console.error(
              `[f2][worklet] emit type=${pluginResponse.type} event=${pluginResponse.event} requestId=${pluginResponse.requestId} frameLen=${outFrame.byteLength}`,
            );
            socket.write(outFrame);
          } else {
            console.error(
              `[f2][worklet] route returned no response for event=${'event' in header ? header.event : '-'}`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Error handling WebSocket message:', message);
      }
    });

    socket.on('close', () => {
      console.error('[f2][worklet] connection closed');
      buffer = new Uint8Array(0);
    });
  });
}
