import type BareBuffer from 'bare-buffer';
import type { HTTPIncomingMessage } from 'bare-http1';
import type { Socket as TCPSocket } from 'bare-tcp';
import ws from 'bare-ws';
import { MAX_FRAME_BYTES } from '../messages/constants';
import {
  createBoundedWriter,
  type BoundedWriter,
} from '../messages/backpressure';

/** The protocol socket as the routing layer sees it. */
export type WebSocketLike = {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'drain', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  write(data: Uint8Array): boolean;
  destroy(): void;
  /** Stops/restarts `data` events (inbound backpressure). */
  pause?(): void;
  resume?(): void;
};

/** Minimal shape of the HTTP request object handed to connection handlers. */
export type LoopbackRequest = {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | number | undefined>;
};

export type LoopbackConnectionHandler = (
  socket: WebSocketLike,
  request: LoopbackRequest,
) => void;

export interface ProtocolSocketOptions {
  /** Idle timeout (ms) on the underlying TCP socket. */
  idleTimeoutMs: number;
  /** Dead-peer timeout (ms): the socket pings at half this interval and is
   * destroyed when nothing (a pong included) arrives within it. */
  deadPeerTimeoutMs: number;
  /** Minimum gap (ms) before an accepted socket may be replaced. */
  replaceMinIntervalMs: number;
  /** Bytes queued behind a stalled reader before pushes are dropped. */
  maxQueuedBytes: number;
}

/**
 * The single protocol socket of a loopback server: the handshake of an
 * upgrade the gate has already admitted, the one-client slot and its
 * replacement rule, the bounded write queue, and the server-initiated push.
 */
export interface ProtocolSocketSlot {
  /** Completes an admitted upgrade, or refuses it through `reject`. */
  accept(
    req: HTTPIncomingMessage,
    socket: TCPSocket,
    head: BareBuffer,
    reject: (reason: string) => void,
  ): void;
  onConnection(handler: LoopbackConnectionHandler): void;
  /** Writes a droppable frame to the connected socket, if any. */
  push(frame: Uint8Array): boolean;
  /** Destroys the connected socket, if any. */
  close(): void;
}

export function createProtocolSocketSlot(
  options: ProtocolSocketOptions,
): ProtocolSocketSlot {
  const handlers: LoopbackConnectionHandler[] = [];
  let active: { client: WebSocketLike; writer: BoundedWriter } | null = null;
  let activeSince = 0;

  return {
    accept(req, socket, head, reject) {
      // Single-client policy: at most one live protocol socket. A new client
      // that passed the gate replaces the current one (a reloaded or suspended
      // WebView leaves a dead socket holding the slot), so replacement is no
      // easier than connecting was. The rate limit bounds eviction churn and
      // refuses before the handshake, so a refused socket never gets a 101.
      if (active && Date.now() - activeSince < options.replaceMinIntervalMs) {
        reject('replacement rate limit (a protocol socket was just accepted)');
        return;
      }

      ws.Server.handshake(req, socket, head, (err) => {
        if (err) {
          reject(`handshake failed (${err.message})`);
          return;
        }
        const raw = new ws.Socket({
          socket,
          isServer: true,
          idleTimeout: options.deadPeerTimeoutMs,
          // One WebSocket message carries one protocol frame.
          maxPayload: MAX_FRAME_BYTES,
        });
        // Every write goes through one bounded queue so a reader that stops
        // reading cannot grow worklet memory: pushes are shed first (newest
        // first); a response is never dropped, and past the hard cap the
        // socket is closed so the client reconnects instead.
        const writer = createBoundedWriter(raw, {
          maxQueuedBytes: options.maxQueuedBytes,
          onOverflow: () => {
            console.error(
              '[loopback] client is not reading and responses are backing up; closing the protocol socket',
            );
            raw.destroy();
          },
        });
        const client: WebSocketLike = {
          on: (event: string, listener: (...args: never[]) => void) =>
            raw.on(event as 'close', listener as () => void),
          write: (data) => writer.write(data),
          destroy: () => raw.destroy(),
          pause: () => raw.pause(),
          resume: () => raw.resume(),
        };
        const previous = active;
        active = { client, writer };
        activeSince = Date.now();
        if (previous) {
          console.warn('[loopback] replaced the existing protocol socket');
          previous.client.destroy();
        }
        raw.on('close', () => {
          writer.clear();
          if (active?.client === client) active = null;
        });
        // A peer that resets or drops the connection surfaces as an 'error'
        // on the socket. Without a listener it would throw out of the emitter
        // and take down the whole worklet, whether or not a connection handler
        // listens too.
        raw.on('error', (err: Error) => {
          console.warn(`[loopback] protocol socket error: ${err.message}`);
          raw.destroy();
        });
        socket.setTimeout(options.idleTimeoutMs, () => raw.destroy());
        for (const handler of handlers) {
          try {
            handler(client, req);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error('Error in loopback WS connection handler:', message);
          }
        }
      });
    },
    onConnection(handler) {
      handlers.push(handler);
    },
    push(frame) {
      return active ? active.writer.write(frame, { droppable: true }) : false;
    },
    close() {
      active?.client.destroy();
    },
  };
}
