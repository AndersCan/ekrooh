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
     * to page JS). The cookie then rides every same-origin request —
     * including the WebSocket upgrade. Browser dev has none (the dev backend
     * runs without auth). */
    __ekrooh?: {
      bootstrap?: string;
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
/** Requests held while connecting before new ones fail fast. */
const DEFAULT_MAX_QUEUED = 256;
/** Sent invokes tracked per socket so a lost socket can fail them. Past this,
 * the oldest entry is forgotten (its caller still has its own timeout). */
const MAX_TRACKED_INFLIGHT = 1024;
/** WebSocket close code the loopback server uses when another document took
 * over the session (the replaced protocol socket). */
export const REPLACED_CLOSE_CODE = 4001;
const SOCKET_LOST_MESSAGE = 'WebSocket closed before the response arrived';
const REPLACED_MESSAGE =
  'WebSocket replaced by another page holding the session; reconnects in 30 s or when this page returns to the foreground';
const CLOSED_MESSAGE = 'WebSocket transport was closed';

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
  /** Whether to bootstrap the session cookie via `POST /login` when a
   * bootstrap nonce is present. Defaults to `true`. */
  login?: boolean;
  /** Reconnect attempts after an unexpected close (boot-window). Default 5. */
  maxRetries?: number;
  /** Initial reconnect backoff in ms, doubling to a 2s cap. Default 250. */
  backoffMs?: number;
  /** How long to wait for `/login` before treating it as failed. Default
   * 2000ms. Exposed so tests can exercise the timeout without waiting. */
  loginTimeoutMs?: number;
  /** A client that never connected gives up only after this long (ms), so
   * unlucky jitter cannot exhaust the retries in a few milliseconds. Default
   * 10s. */
  minBootWindowMs?: number;
  /** How long (ms) a socket may stay connecting before it is dropped and
   * retried. Default 10s. */
  openTimeoutMs?: number;
  /** Requests held while connecting; past it, new requests fail fast with
   * `TRANSPORT_ERROR`. Default 256. */
  maxQueued?: number;
  /** Fold the server's recent `[loopback]` upgrade-rejection log lines into
   * the give-up error text. Off by default: log lines are diagnostics, not
   * error messages a UI should show. Turn it on in a diagnostic harness. */
  diagnostics?: boolean;
}

/**
 * `websocket.send` sends exactly the bytes a typed-array view covers (its
 * offset and length), so the frame goes out as is. This was a `slice()` copy of
 * the whole frame, kept for a pooled-`Buffer` view that the browser never
 * produces.
 */
function toSendable(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource;
}

/** Upper bound on server-log lines folded into a give-up error (it lands in
 * an XCTest accessibility label, so it must stay short). */
const LOG_TAIL_LINES = 3;
/** Per-line character cap for the folded log tail. */
const LOG_TAIL_LINE_CHARS = 200;
/** How long to wait for the log-tail fetch before giving up on enrichment. */
const LOG_TAIL_TIMEOUT_MS = 2000;

/**
 * Fetches the loopback server's recent `[loopback]` rejection lines over HTTP.
 * This works precisely because the failure class is upgrade-only: the page
 * itself loads from the same server, so the auth-gated `GET /logs` route still
 * answers when every WebSocket handshake dies. Returns null when nothing can
 * be learned (no fetch available, network error, timeout).
 */
async function serverRejectionTail(wsUrl: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null;
  const httpBase = wsUrl.startsWith('wss://')
    ? `https://${wsUrl.slice('wss://'.length)}`
    : wsUrl.startsWith('ws://')
      ? `http://${wsUrl.slice('ws://'.length)}`
      : wsUrl;
  try {
    const response = await Promise.race([
      fetch(`${httpBase}/logs?tail=50&format=text`),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), LOG_TAIL_TIMEOUT_MS),
      ),
    ]);
    if (response === null) return null;
    // A non-200 is itself diagnostic: `/logs` inherits the session gate, so a
    // 401/403 here points straight at the auth path.
    if (!response.ok) {
      return `server log tail unavailable (HTTP ${response.status})`;
    }
    const text = await response.text();
    const lines = text
      .split('\n')
      .filter((line) => line.includes('[loopback]'))
      .slice(-LOG_TAIL_LINES)
      .map((line) => line.slice(0, LOG_TAIL_LINE_CHARS));
    return lines.length > 0
      ? lines.join(' | ')
      : 'no [loopback] rejection lines in server log tail';
  } catch {
    return null;
  }
}

export interface MessageTransport {
  send(
    type: MessageTypeValue,
    header: MessageHeader,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ): void;
  subscribe(handler: (message: WireMessage) => void): () => void;
  /** Closes the transport for good: drops the socket, stops reconnecting,
   * removes its listeners and fails every pending request with
   * `TRANSPORT_ERROR`. Later sends fail the same way. Optional so existing
   * custom transports still satisfy the interface. */
  close?(): void;
}

export function createWebSocketTransport(
  urlOrOptions: string | CreateWebSocketTransportOptions = {},
): MessageTransport {
  const options: CreateWebSocketTransportOptions =
    typeof urlOrOptions === 'string' ? { url: urlOrOptions } : urlOrOptions;
  const url = options.url ?? defaultWsUrl();
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
  const initialBackoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  const diagnostics = options.diagnostics === true;
  // The one-time bootstrap nonce is exchanged for the HttpOnly cookie; it is
  // never placed in a URL.
  const bridge = typeof window !== 'undefined' ? window.__ekrooh : undefined;
  const credential = bridge?.bootstrap;
  const shouldLogin =
    options.login !== false &&
    typeof credential === 'string' &&
    credential.length > 0;

  const listeners = new Set<(message: WireMessage) => void>();
  const queued: QueuedMessage[] = [];
  let socket: WebSocket | null = null;
  /** Invokes sent on the current socket and not yet answered, by requestId.
   * A socket's responses can only come back on that socket, so losing it
   * fails them at once instead of leaving callers on their timeouts. */
  const inflight = new Map<string, MessageHeader>();
  /** Set once `/login` succeeded: the HttpOnly cookie outlives a give-up. */
  let loggedIn = false;
  let started = false;
  let closed = false;
  /** Human-readable reason when the give-up was caused by the `/login`
   * exchange. The surfaced transport error is the only telemetry CI gets
   * from an on-device WebView, so it must say which path fired instead of
   * collapsing login rejection, login timeout and retry exhaustion into a
   * single string. */
  let loginFailureDetail: string | null = null;

  /** Error text for requests lost to a terminal give-up. */
  function gaveUpMessage(): string {
    return loginFailureDetail === null
      ? `${WS_DISCONNECTED_MESSAGE} (socket never opened after ${maxRetries} retries)`
      : `${WS_DISCONNECTED_MESSAGE} (${loginFailureDetail})`;
  }

  const machine = createConnectionMachine({
    url,
    maxRetries,
    initialBackoffMs: initialBackoff,
    maxBackoffMs: MAX_BACKOFF_MS,
    minBootWindowMs: options.minBootWindowMs,
    openTimeoutMs: options.openTimeoutMs,
  });

  const reconnectingMessage = `${WS_DISCONNECTED_MESSAGE} (reconnecting)`;

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

  /** Sends on the open socket, tracking invokes until they are answered. */
  const sendNow = (
    target: WebSocket,
    bytes: Uint8Array,
    header: MessageHeader,
  ) => {
    if (
      header.type === 'INVOKE_REQUEST' &&
      typeof header.requestId === 'string'
    ) {
      if (inflight.size >= MAX_TRACKED_INFLIGHT) {
        const oldest = inflight.keys().next().value;
        if (oldest !== undefined) inflight.delete(oldest);
      }
      inflight.set(header.requestId, header);
    }
    target.send(toSendable(bytes));
  };

  const flushQueued = () => {
    const target = socket;
    if (!target) return;
    const pending = queued.splice(0);
    for (const queuedMessage of pending) {
      sendNow(target, queuedMessage.bytes, queuedMessage.header);
    }
  };

  /** Forgets the current socket: fails the invokes sent on it (their answers
   * can only arrive on that socket) and closes it if it is still around.
   * Late events from it are ignored (`socket !== current`). */
  function dropSocket(message: string) {
    const lost = socket;
    socket = null;
    const pending = [...inflight.values()];
    inflight.clear();
    for (const header of pending) emitTransportError(header, message);
    if (lost && lost.readyState !== WebSocket.CLOSED) {
      try {
        lost.close();
      } catch {
        // Already closing; nothing to release.
      }
    }
  }

  /** Opens a WebSocket for the machine's current URL and wires it to the
   * machine's lifecycle events. */
  function openSocket() {
    const current = new WebSocket(machine.url());
    socket = current;
    current.binaryType = 'arraybuffer';

    // A socket that has been replaced (the foreground check treated it as lost)
    // may still fire late events; they must not drive the machine for its
    // successor.
    current.onopen = () => {
      if (socket !== current) return;
      machine.sendOpen();
      flushQueued();
    };

    current.onmessage = (event) => {
      if (socket !== current) return;
      const size = event.data?.byteLength ?? 0;
      if (size === 0) {
        try {
          console.debug('[ws] received empty frame; ignoring');
        } catch {
          // Observability only — never throw into the caller.
        }
        return;
      }
      try {
        const message = protocol.decode(event.data as ArrayBuffer);
        if (
          message.header.type === 'INVOKE_RESPONSE' &&
          typeof message.header.requestId === 'string'
        ) {
          inflight.delete(message.header.requestId);
        }
        for (const listener of listeners) listener(message);
      } catch (err) {
        console.error('Failed to parse WS message:', err);
      }
    };

    current.onclose = (event?: { code?: number }) => {
      if (socket !== current) return;
      const replaced = event?.code === REPLACED_CLOSE_CODE;
      dropSocket(replaced ? REPLACED_MESSAGE : SOCKET_LOST_MESSAGE);
      // No `opened` flag: the machine derives it from its own state.
      if (replaced) machine.sendReplaced();
      else machine.sendClose();
    };

    current.onerror = () => {
      // `close` always follows; reconnect/give-up is handled there.
    };
  }

  // The machine drives the shell: entering `opening` means a socket should
  // exist (first connect, or a retry after backoff); `gaveUp` fails the queue.
  machine.onChange((state) => {
    // Leaving `opening`/`connected` without the socket's own close (open
    // timeout, a stale socket on foreground, close()) still loses it.
    if (state !== 'opening' && state !== 'connected' && socket) {
      dropSocket(state === 'closed' ? CLOSED_MESSAGE : SOCKET_LOST_MESSAGE);
    }
    if (state === 'opening') {
      openSocket();
    } else if (state === 'gaveUp') {
      void failWithServerDetail();
    } else if (state === 'closed') {
      failQueuedMessages(CLOSED_MESSAGE);
    } else if (state === 'idle' && started) {
      // WAKE after a give-up: start over (login again if it never succeeded).
      void bootstrap();
    } else if (state === 'backoff' && machine.isReplaced()) {
      // Another document holds the session: do not hold requests for it.
      failQueuedMessages(REPLACED_MESSAGE);
    } else if (state === 'backoff' && machine.isDegraded()) {
      // The outage outlived the quick-retry window: stop holding requests for a
      // reconnect that may be far off. Retrying continues in the background.
      failQueuedMessages(reconnectingMessage);
    }
  });

  /** The app returned to the foreground. A suspended page may hold a socket
   * the browser already closed without firing `onclose`; treat it as lost, and
   * retry now instead of waiting out the backoff. */
  function onForeground() {
    if (
      machine.isConnected() &&
      socket &&
      socket.readyState !== WebSocket.OPEN
    ) {
      dropSocket(SOCKET_LOST_MESSAGE);
      machine.sendClose();
    }
    machine.sendWake();
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') onForeground();
  };
  const hasDocument =
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function';
  if (hasDocument) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  /** Terminal give-up: when we have no better name for the failure, fold the
   * server's own view (its `[loopback]` upgrade rejections) into the surfaced
   * error. Async by one localhost round-trip — queued requests are already
   * terminally lost, so a short delay changes nothing semantically. */
  async function failWithServerDetail(): Promise<void> {
    let message = gaveUpMessage();
    if (diagnostics && loginFailureDetail === null) {
      const tail = await serverRejectionTail(url);
      if (tail !== null) message = `${message}; server: ${tail}`;
    }
    failQueuedMessages(message);
  }

  /** One `/login` attempt, classified for the bootstrap race. `spent` means
   * the server recognized our nonce as already consumed by a sibling
   * document whose session cookie is on its way — worth exactly one retry. */
  function postLogin(): Promise<'ok' | 'spent' | 'rejected' | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loginTimeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), loginTimeoutMs);
    });
    const attempt = fetch('/login', {
      method: 'POST',
      body: credential,
    }).then((response) => {
      if (response.ok) return 'ok';
      return response.status === 409 ? 'spent' : 'rejected';
    });
    return Promise.race([attempt, loginTimeout]).finally(() =>
      clearTimeout(timer),
    );
  }

  async function bootstrap() {
    if (shouldLogin && !loggedIn) {
      loginFailureDetail = null;
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
          loggedIn = true;
          machine.sendLoginOk();
        } else {
          // Login rejected or timed out; the machine may retry the socket, but
          // there is no token-URL fallback — a token must never be placed in a
          // URL (the loopback server rejects `?token=`).
          loginFailureDetail =
            outcome === 'timeout'
              ? `session login timed out after ${loginTimeoutMs}ms`
              : 'session login rejected';
          machine.sendLoginFail();
        }
      } catch {
        loginFailureDetail = 'session login request failed';
        machine.sendLoginFail();
      }
    } else {
      machine.sendLoginOk();
    }
  }

  started = true;
  void bootstrap();

  return {
    send(type, header, payload) {
      if (closed) {
        emitTransportError(header, CLOSED_MESSAGE);
        return;
      }
      const encoded = protocol.encode(type, header, payload);
      if (
        machine.isConnected() &&
        socket &&
        socket.readyState === WebSocket.OPEN
      ) {
        sendNow(socket, encoded, header);
        return;
      }
      if (machine.isGaveUp()) {
        emitTransportError(header, gaveUpMessage());
        return;
      }
      if (machine.isReplaced()) {
        emitTransportError(header, REPLACED_MESSAGE);
        return;
      }
      if (machine.state() === 'backoff' && machine.isDegraded()) {
        emitTransportError(header, reconnectingMessage);
        return;
      }
      if (queued.length >= maxQueued) {
        emitTransportError(
          header,
          `${WS_DISCONNECTED_MESSAGE} (${maxQueued} requests already waiting for the connection)`,
        );
        return;
      }
      // Queue while connecting (first open, backoff, login).
      queued.push({ bytes: encoded, header });
    },
    close() {
      if (closed) return;
      closed = true;
      if (hasDocument) {
        document.removeEventListener?.('visibilitychange', onVisibilityChange);
      }
      machine.sendStop();
      // A transport closed before its machine left `idle` (login pending)
      // still owes its callers an answer.
      dropSocket(CLOSED_MESSAGE);
      failQueuedMessages(CLOSED_MESSAGE);
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
