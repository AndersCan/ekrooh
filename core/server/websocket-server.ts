import { MessageType } from '../messages';
import type { BareRuntimeContext } from '../messages/create-bare-runtime-context';
import { createFrameChannel } from '../messages/frame-channel';
import type { MessageHeader, MessageProtocol } from '../messages';
import type { LoopbackServer } from './static-file-server';

/** Routed calls pending on one socket before it stops being read. */
const MAX_PENDING_ROUTES = 32;

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
 * client, idle timeout); this layer runs one frame channel per socket. A peer
 * that sends a malformed frame is not recoverable on that socket, so it is
 * torn down and the client reconnects.
 */
export function attachWebSocketProtocol(
  server: LoopbackServer,
  context: BareRuntimeContext,
) {
  const { protocol, pluginRouter } = context;

  server.onConnection((socket) => {
    const channel = createFrameChannel({
      name: '[ws]',
      protocol,
      router: pluginRouter,
      write: (frame) => socket.write(frame),
      onMalformed: { kind: 'close', close: () => socket.destroy() },
      // Stop reading while too much routed work is pending, so a fast sender
      // cannot queue calls faster than they complete.
      inbound: {
        maxPending: MAX_PENDING_ROUTES,
        pause: () => socket.pause?.(),
        resume: () => socket.resume?.(),
      },
    });

    socket.on('data', (chunk) => channel.push(chunk));
    socket.on('close', () => channel.close());
    // Contain transport errors (peer reset, ECONNRESET) instead of letting an
    // unhandled 'error' throw out of the EventEmitter and crash the whole
    // runtime. A single dropped peer must not take down every other
    // connection.
    socket.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ws] connection error:', message);
      channel.close();
      socket.destroy();
    });
  });
}
