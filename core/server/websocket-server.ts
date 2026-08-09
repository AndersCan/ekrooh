import ws from 'bare-ws';
import { MessageType } from '../messages';
import { BareRuntimeContext } from '../messages/create-bare-runtime-context';

/**
 * bare-ws ships runtime support for `port` (passed through to the underlying
 * HTTP server's `listen(opts)`), but its type definitions omit it.
 */
type BareServerOptions = ConstructorParameters<typeof ws.Server>[0];

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('Expected Uint8Array or ArrayBuffer from socket data');
}

export function startWebSocketServer(context: BareRuntimeContext) {
  const { protocol, pluginRouter } = context;
  const server = new ws.Server({ port: 8080 } as BareServerOptions);

  server.on('connection', (socket) => {
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
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Error handling WebSocket message:', message);
      }
    });
  });
}
