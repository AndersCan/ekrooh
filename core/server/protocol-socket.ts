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
  /** Minimum gap (ms) before an accepted socket may be replaced. An upgrade
   * that arrives sooner is held until the gap has passed, not refused. */
  replaceMinIntervalMs: number;
  /** Bytes queued behind a stalled reader before pushes are dropped. */
  maxQueuedBytes: number;
}

/**
 * The single protocol socket of a loopback server: the handshake of an
 * upgrade the gate has already admitted, the one-client slot and its
 * replacement rule, the bounded write queue, and the server-initiated push.
 */
/** Refuses an upgrade. `status` is the HTTP status to answer with, when the
 * connection is still in a state to receive one. */
export type RejectUpgrade = (reason: string, status?: 429) => void;

export interface ProtocolSocketSlot {
  /** Completes an admitted upgrade, or refuses it through `reject`. */
  accept(
    req: HTTPIncomingMessage,
    socket: TCPSocket,
    head: BareBuffer,
    reject: RejectUpgrade,
  ): void;
  onConnection(handler: LoopbackConnectionHandler): void;
  /** Writes a droppable frame to the connected socket, if any. */
  push(frame: Uint8Array): boolean;
  /** Destroys the connected socket and any held upgrade. */
  close(): void;
}

export function createProtocolSocketSlot(
  options: ProtocolSocketOptions,
): ProtocolSocketSlot {
  const handlers: LoopbackConnectionHandler[] = [];
  let active: { client: WebSocketLike; writer: BoundedWriter } | null = null;
  let activeSince = 0;
  /** The upgrade waiting out the replacement interval. At most one waits: a
   * newer one supersedes it, since it would have evicted it on arrival. */
  let waiting: {
    socket: TCPSocket;
    reject: RejectUpgrade;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function accept(
    req: HTTPIncomingMessage,
    socket: TCPSocket,
    head: BareBuffer,
    reject: RejectUpgrade,
  ) {
    // Single-client policy: at most one live protocol socket. A new client
    // that passed the gate replaces the current one (a reloaded or suspended
    // WebView leaves a dead socket holding the slot), so replacement is no
    // easier than connecting was. The minimum interval bounds eviction churn
    // between two live clients. An upgrade inside it is held, not refused: a
    // reconnect right after a connect is the normal reload case, and a refusal
    // reaches the page only as a failed socket, costing one of its retries.
    const wait = active
      ? activeSince + options.replaceMinIntervalMs - Date.now()
      : 0;
    if (wait > 0) {
      if (waiting) {
        clearTimeout(waiting.timer);
        waiting.reject('superseded by a newer upgrade', 429);
      }
      const timer = setTimeout(() => {
        waiting = null;
        accept(req, socket, head, reject);
      }, wait);
      waiting = { socket, reject, timer };
      socket.on('close', () => {
        if (waiting?.socket !== socket) return;
        clearTimeout(waiting.timer);
        waiting = null;
      });
      // A peer reset while held would otherwise throw out of the emitter.
      socket.on('error', () => socket.destroy());
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
  }

  return {
    accept,
    onConnection(handler) {
      handlers.push(handler);
    },
    push(frame) {
      return active ? active.writer.write(frame, { droppable: true }) : false;
    },
    close() {
      active?.client.destroy();
      if (waiting) {
        clearTimeout(waiting.timer);
        waiting.socket.destroy();
        waiting = null;
      }
    },
  };
}
