import ws from 'bare-ws';
import { MessageType } from '../messages';
import { BareRuntimeContext } from '../messages/create-bare-runtime-context';

export function startWebSocketServer(context: BareRuntimeContext) {
  const { protocol, pluginRouter } = context;
  const server = new ws.Server({ port: 8080 });

  server.on('connection', (socket) => {
    socket.on('data', async (data) => {
      try {
        const len = data.length ?? data.byteLength ?? 0;
        if (len === 0) return;

        const parsed = protocol.decode(data);
        const header = parsed.header;

        const pluginResponse = await pluginRouter.route(header, parsed.payload);
        if (pluginResponse) {
          socket.write(protocol.encode(MessageType.ENVELOPE, pluginResponse, null));
          return;
        }

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Error handling WebSocket message:', message);
      }
    });
  });
}
