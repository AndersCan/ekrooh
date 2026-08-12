import {
  ErrorCode,
  MessageHeader,
  MessageProtocol,
  MessageType,
  MessageTypeValue,
  WireMessage,
} from '../core/messages';

declare global {
  interface Window {
    /** Per-session token injected by the embedding shell on-device. The page
     * exchanges it for a session cookie via `POST /login`, which then rides
     * every same-origin request — including the WebSocket upgrade. Browser
     * dev has none (the dev backend runs without auth). */
    __lessBareToken?: string;
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

/**
 * Append the session token to the URL as a `?token=...` query param, keeping
 * any query the URL already carries. Fallback for clients that cannot complete
 * the `/login` cookie bootstrap (e.g. non-browser transports).
 */
function withToken(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.toString();
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
    typeof window !== 'undefined' ? window.__lessBareToken : undefined;
  const shouldLogin =
    options.login !== false && typeof token === 'string' && token.length > 0;

  const listeners = new Set<(message: WireMessage) => void>();
  const queued: QueuedMessage[] = [];
  let socket: WebSocket | null = null;
  let retries = 0;
  let nextUrl = url;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the query-token URL is already in play (from a failed `/login` or
   * a rejected upgrade). Guards the fallback so it fires at most once. */
  let tokenFallbackTried = false;

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

  function open() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket = new WebSocket(nextUrl);
    socket.binaryType = 'arraybuffer';
    let opened = false;

    socket.onopen = () => {
      opened = true;
      retries = 0;
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
      // A close before ever opening means the upgrade was rejected — the
      // `/login` cookie may not have ridden the handshake (WKWebView/WebView
      // cookie-on-WS behavior varies). If a token is present and the query
      // token URL isn't already in play, retry it immediately: this is a
      // different connection, so it neither consumes a retry nor backs off.
      if (
        !opened &&
        !tokenFallbackTried &&
        typeof token === 'string' &&
        token.length > 0
      ) {
        tokenFallbackTried = true;
        nextUrl = withToken(url, token);
        open();
        return;
      }
      if (retries >= maxRetries) {
        failQueuedMessages(WS_DISCONNECTED_MESSAGE);
        console.warn(
          `WebSocket disconnected after ${maxRetries} retries; giving up.`,
        );
        return;
      }
      retries += 1;
      const delay = Math.min(
        initialBackoff * 2 ** (retries - 1),
        MAX_BACKOFF_MS,
      );
      reconnectTimer = setTimeout(open, delay);
    };

    socket.onerror = () => {
      // `close` always follows; reconnect/give-up is handled there.
    };
  }

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
        if (outcome !== 'ok') {
          // Login rejected or timed out; fall back to the query param (the
          // server still accepts it for non-cookie clients).
          nextUrl = withToken(url, token!);
          tokenFallbackTried = true;
        }
      } catch {
        nextUrl = withToken(url, token!);
        tokenFallbackTried = true;
      }
    }
    open();
  }

  void bootstrap();

  return {
    send(type, header, payload) {
      const encoded = protocol.encode(type, header, payload);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(toArrayBuffer(encoded));
        return;
      }
      // Queue while connecting, during the login window, while a reconnect is
      // scheduled, or while a close is still being processed (CLOSING) — the
      // onclose handler decides between reconnecting and failing.
      const recovering =
        socket === null ||
        reconnectTimer !== null ||
        socket.readyState === WebSocket.CONNECTING ||
        socket.readyState === WebSocket.CLOSING;
      if (recovering) {
        queued.push({ bytes: encoded, header });
        return;
      }
      emitTransportError(header, WS_DISCONNECTED_MESSAGE);
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
