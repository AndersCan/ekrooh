import { MessageType } from '../messages';
import { BareRuntimeContext } from '../messages/create-bare-runtime-context';
import { createFrameDecoder } from '../messages/framing';
import type { MessageHeader, MessageProtocol } from '../messages';
import type { LoopbackServer } from './static-file-server';

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('Expected Uint8Array or ArrayBuffer from socket data');
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
    // The wire format is `[version][type][headerLen(2)][payloadLen(3)]
    // [header][payload]`: a reassembler reads the frame length from bytes 2-3
    // (16-bit header) and bytes 4-6 (24-bit payload length), written by
    // `encode` — payload-bearing invokes (e.g. `payloadEcho`) stay
    // self-delimiting even when a peer transport strips unknown JSON header
    // fields. The per-socket frame decoder drains synchronously: a single frame
    // may arrive split across chunks, or several frames coalesced into one, and
    // the routing below is serialized per socket so concurrent data events can
    // never interleave on a shared buffer.
    const decoder = createFrameDecoder(protocol);
    let inflight: Promise<void> = Promise.resolve();

    socket.on('data', (raw) => {
      let messages;
      try {
        const data = toUint8Array(raw);
        const dbg = Array.from(data.subarray(0, Math.min(16, data.byteLength)))
          .map((x) => x.toString(16).padStart(2, '0'))
          .join(' ');
        console.log(
          '[f2-raw][server] on(data) len=' + data.byteLength + ' head=' + dbg,
        );
        if (data.byteLength === 0) {
          console.debug('[ws] received empty data chunk, ignoring');
          return;
        }
        messages = decoder.push(data);
        console.log('[f2-raw][server] decoded messages=' + messages.length);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Error handling WebSocket message: ' + message);
        socket.destroy();
        return;
      }
      if (messages.length === 0) return;

      inflight = inflight
        .then(async () => {
          for (const parsed of messages) {
            const pluginResponse = await pluginRouter.route(
              parsed.header,
              parsed.payload,
            );
            if (pluginResponse) {
              socket.write(
                protocol.encode(MessageType.ENVELOPE, pluginResponse, null),
              );
            }
          }
        })
        .catch((err) => {
          // A routing/encode failure must not wedge the per-socket chain; the
          // stream itself stays usable. Decode/framing failures already
          // destroyed the socket above.
          const message = err instanceof Error ? err.message : String(err);
          console.error('Error handling WebSocket message:', message);
        });
    });

    socket.on('close', () => {
      decoder.clear();
    });
  });
}
