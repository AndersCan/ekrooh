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
     * `bootstrap` is a one-time nonce the page exchanges for a session cookie
     * via `POST /login` (single-use — the raw session token is never exposed
     * to page JS). `token` remains as a legacy login fallback for consumers
     * that still inject it. The cookie then rides every same-origin request —
     * including the WebSocket upgrade. Browser dev has none (the dev backend
     * runs without auth). */
    __ekrooh?: {
      bootstrap?: string;
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
/** Wait before the single retry after a 409 (`bootstrap` nonce already
 * spent): long enough for the sibling document's `Set-Cookie` to land. */
const SPENT_NONCE_RETRY_MS = 250;

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
  // `bootstrap` (the one-time nonce) is preferred; `token` remains a legacy
  // login fallback for consumers that inject it. Neither is ever placed in a
  // URL — the transport exchanges the credential for the HttpOnly cookie.
  const bridge = typeof window !== 'undefined' ? window.__ekrooh : undefined;
  const credential = bridge?.bootstrap ?? bridge?.token;
  const shouldLogin =
    options.login !== false &&
    typeof credential === 'string' &&
    credential.length > 0;

  const listeners = new Set<(message: WireMessage) => void>();
  const queued: QueuedMessage[] = [];
  let socket: WebSocket | null = null;

  const machine = createConnectionMachine({
    url,
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
  // exist (first connect, or a retry after backoff); `gaveUp` fails the queue.
  machine.onChange((state) => {
    if (state === 'opening') {
      openSocket();
    } else if (state === 'gaveUp') {
      failQueuedMessages(WS_DISCONNECTED_MESSAGE);
    }
  });

  /** One `/login` attempt, classified for the bootstrap race. `spent` means
   * the server recognized our nonce as already consumed by a sibling
   * document whose session cookie is on its way — worth exactly one retry. */
  function postLogin(): Promise<'ok' | 'spent' | 'rejected' | 'timeout'> {
    const loginTimeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), LOGIN_TIMEOUT_MS);
    });
    const attempt = fetch('/login', {
      method: 'POST',
      body: credential,
    }).then((response) => {
      if (response.ok) return 'ok';
      return response.status === 409 ? 'spent' : 'rejected';
    });
    return Promise.race([attempt, loginTimeout]);
  }

  async function bootstrap() {
    if (shouldLogin) {
      try {
        let outcome = await postLogin();
        if (outcome === 'spent') {
          // A sibling document spent the shared nonce first; give its
          // session cookie a beat to land, then retry once — the server's
          // by-session path will accept it.
          await new Promise((resolve) => {
            setTimeout(resolve, SPENT_NONCE_RETRY_MS);
          });
          outcome = await postLogin();
        }
        if (outcome === 'ok') {
          machine.sendLoginOk();
        } else {
          // Login rejected or timed out; the machine may retry the socket, but
          // there is no token-URL fallback — a token must never be placed in a
          // URL (the loopback server rejects `?token=`).
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
      // Queue while connecting (first open, backoff, login).
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
