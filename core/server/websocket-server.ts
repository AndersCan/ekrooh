import { MessageType } from '../messages';
import { BareRuntimeContext } from '../messages/create-bare-runtime-context';
import type { LoopbackServer } from './static-file-server';

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('Expected Uint8Array or ArrayBuffer from socket data');
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
    socket.on('data', async (raw) => {
      try {
        const data = toUint8Array(raw);
        if (data.byteLength === 0) return;

        const parsed = protocol.decode(data);
        const header = parsed.header;

        const pluginResponse = await pluginRouter.route(header, parsed.payload);
        if (pluginResponse) {
          socket.write(
            protocol.encode(MessageType.ENVELOPE, pluginResponse, null),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Error handling WebSocket message:', message);
      }
    });
  });
}
