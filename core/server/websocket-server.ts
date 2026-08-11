import ws from 'bare-ws';
import { MessageType } from '../messages';
import { BareRuntimeContext } from '../messages/create-bare-runtime-context';

/**
 * bare-ws ships runtime support for `port` (passed through to the underlying
 * HTTP server's `listen(opts)`), but its type definitions omit it.
 */
type BareServerOptions = ConstructorParameters<typeof ws.Server>[0];

/** Extracts the `token` query param from a raw query string (`a=1&token=x`). */
function tokenFromQuery(query: string): string | null {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) === 'token') return pair.slice(eq + 1);
  }
  return null;
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('Expected Uint8Array or ArrayBuffer from socket data');
}

export function startWebSocketServer(context: BareRuntimeContext) {
  const { protocol, pluginRouter } = context;
  // Optional token gate. The Bare worklet runtime has no `process` global
  // (only the Node dev server does), so the gate is off unless a host sets
  // BARE_WS_TOKEN — dev behavior stays unchanged, and the on-device gate is
  // wired with a worklet-owned token in the unified-server milestone.
  const authToken =
    typeof process !== 'undefined' ? process.env.BARE_WS_TOKEN : undefined;
  const server = new ws.Server({ port: 8080 } as BareServerOptions);

  server.on('connection', (socket, request) => {
    // Optional token gate: when BARE_WS_TOKEN is set, every connection must
    // present it as a `?token=` query param on the request URL (e.g.
    // `ws://127.0.0.1:8080/?token=...`). bare-ws hands the handshake HTTP
    // request as the second connection argument; it is a bare-http1
    // HTTPIncomingMessage with a `url` field (its types label it
    // HTTPClientRequest, hence the narrow cast). Connections without a
    // matching token are dropped. With BARE_WS_TOKEN unset the gate is off
    // and dev behavior is unchanged.
    if (authToken) {
      const requestUrl = (request as { url?: string }).url ?? '';
      const [, query = ''] = requestUrl.split('?');
      if (tokenFromQuery(query) !== authToken) {
        socket.destroy();
        return;
      }
    }

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
