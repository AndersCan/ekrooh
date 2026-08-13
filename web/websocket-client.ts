import {
  ErrorCode,
  MessageHeader,
  MessageProtocol,
  MessageType,
  MessageTypeValue,
  WireMessage,
} from '../core/messages';
import { createConnectionMachine } from './connection-machine';

declare global {
  interface Window {
    /** Per-session bridge state injected by the embedding shell on-device.
     * `token` is exchanged for a session cookie via `POST /login`, which then
     * rides every same-origin request — including the WebSocket upgrade.
     * Browser dev has none (the dev backend runs without auth). */
    __ekrooh?: {
      token?: string;
      [key: string]: unknown;
    };
    /** Set by the embedding shell on-device. */
    BareShell?: boolean;
  }
}

const protocol = new MessageProtocol();
const WS_DISCONNECTED_MESSAGE =
  'WebSocket disconnected before request could be sent';

const DEFAULT_RETRIES = 5;
const DEFAULT_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2000;
const LOGIN_TIMEOUT_MS = 2000;

/** Same-origin default: on-device the page is served by the loopback server,
 * so `ws://<location.host>` is the protocol socket with no mixed content and
 * no custom scheme. */
function defaultWsUrl(): string {
  if (typeof window !== 'undefined' && window.location?.host) {
    return `ws://${window.location.host}`;
  }
  return 'ws://localhost:8080';
}

type QueuedMessage = {
  bytes: Uint8Array;
  header: MessageHeader;
};

export interface CreateWebSocketTransportOptions {
  /** WebSocket URL. Defaults to the page's same-origin (`ws://location.host`).
   * Browser dev passes `VITE_BARE_WS_URL` explicitly. */
  url?: string;
  /** Whether to bootstrap the session cookie via `POST /login` when a token
   * is present. Defaults to `true`. */
  login?: boolean;
  /** Reconnect attempts after an unexpected close (boot-window). Default 5. */
  maxRetries?: number;
  /** Initial reconnect backoff in ms, doubling to a 2s cap. Default 250. */
  backoffMs?: number;
}

/**
 * `websocket.send` needs a `BufferSource` backed by a plain `ArrayBuffer`;
 * the codec may produce a view into a pooled Buffer, so slice a standalone
 * copy of just the frame.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export interface MessageTransport {
  send(
    type: MessageTypeValue,
    header: MessageHeader,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ): void;
  subscribe(handler: (message: WireMessage) => void): () => void;
}

export function createWebSocketTransport(
  urlOrOptions: string | CreateWebSocketTransportOptions = {},
): MessageTransport {
  const options: CreateWebSocketTransportOptions =
    typeof urlOrOptions === 'string' ? { url: urlOrOptions } : urlOrOptions;
  const url = options.url ?? defaultWsUrl();
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
  const initialBackoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const token =
    typeof window !== 'undefined' ? window.__ekrooh?.token : undefined;
  const shouldLogin =
    options.login !== false && typeof token === 'string' && token.length > 0;

  const listeners = new Set<(message: WireMessage) => void>();
  const queued: QueuedMessage[] = [];
  let socket: WebSocket | null = null;

  const machine = createConnectionMachine({
    url,
    token: typeof token === 'string' ? token : undefined,
    maxRetries,
    initialBackoffMs: initialBackoff,
    maxBackoffMs: MAX_BACKOFF_MS,
  });

  const emitTransportError = (header: MessageHeader, message: string) => {
    if (header.type !== 'INVOKE_REQUEST') {
      return;
    }
    for (const listener of listeners) {
      listener({
        type: MessageType.ENVELOPE,
        header: {
          type: 'INVOKE_RESPONSE',
          pluginId: header.pluginId,
          event: header.event,
          requestId: header.requestId,
          error: {
            code: ErrorCode.TRANSPORT_ERROR,
            message,
          },
        },
        payload: new Uint8Array(0),
      });
    }
  };

  const failQueuedMessages = (message: string) => {
    for (const queuedMessage of queued) {
      emitTransportError(queuedMessage.header, message);
    }
    queued.length = 0;
  };

  const flushQueued = () => {
    for (const queuedMessage of queued) {
      socket?.send(toArrayBuffer(queuedMessage.bytes));
    }
    queued.length = 0;
  };

  /** Opens a WebSocket for the machine's current URL and wires it to the
   * machine's lifecycle events. */
  function openSocket() {
    socket = new WebSocket(machine.url());
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      machine.sendOpen();
      flushQueued();
    };

    socket.onmessage = (event) => {
      const size = event.data?.byteLength ?? 0;
      if (size === 0) return;
      try {
        const message = protocol.decode(event.data as ArrayBuffer);
        for (const listener of listeners) listener(message);
      } catch (err) {
        console.error('Failed to parse WS message:', err);
      }
    };

    socket.onclose = () => {
      // No `opened` flag: the machine derives it from its own state.
      machine.sendClose();
    };

    socket.onerror = () => {
      // `close` always follows; reconnect/give-up is handled there.
    };
  }

  // The machine drives the shell: entering `opening` means a socket should
  // exist (first connect, a retry after backoff, or the immediate token-URL
  // fallback after a rejected upgrade); `gaveUp` fails the queue.
  machine.onChange((state) => {
    if (state === 'opening') {
      openSocket();
    } else if (state === 'gaveUp') {
      failQueuedMessages(WS_DISCONNECTED_MESSAGE);
    }
  });

  async function bootstrap() {
    if (shouldLogin) {
      const loginTimeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), LOGIN_TIMEOUT_MS);
      });
      try {
        const outcome = await Promise.race([
          fetch('/login', { method: 'POST', body: token }).then((response) =>
            response.ok ? 'ok' : 'rejected',
          ),
          loginTimeout,
        ]);
        if (outcome === 'ok') {
          machine.sendLoginOk();
        } else {
          // Login rejected or timed out; the machine switches to the query
          // token URL (the server still accepts it for non-cookie clients).
          machine.sendLoginFail();
        }
      } catch {
        machine.sendLoginFail();
      }
    } else {
      machine.sendLoginOk();
    }
  }

  void bootstrap();

  return {
    send(type, header, payload) {
      const encoded = protocol.encode(type, header, payload);
      if (
        machine.isConnected() &&
        socket &&
        socket.readyState === WebSocket.OPEN
      ) {
        socket.send(toArrayBuffer(encoded));
        return;
      }
      if (machine.isGaveUp()) {
        emitTransportError(header, WS_DISCONNECTED_MESSAGE);
        return;
      }
      // Queue while connecting (first open, backoff, token fallback, login).
      queued.push({ bytes: encoded, header });
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
