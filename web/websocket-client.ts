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
    /** Per-session token injected by the embedding shell on-device. The
     * worklet WS server validates it when auth is enabled; browser dev has
     * none. */
    __lessBareToken?: string;
  }
}

const protocol = new MessageProtocol();
const WS_DISCONNECTED_MESSAGE =
  'WebSocket disconnected before request could be sent';

/**
 * Append the session token to the URL as a `?token=...` query param, keeping
 * any query the URL already carries.
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
  url = 'ws://localhost:8080',
): MessageTransport {
  const token =
    typeof window !== 'undefined' ? window.__lessBareToken : undefined;
  const websocket = new WebSocket(token ? withToken(url, token) : url);
  websocket.binaryType = 'arraybuffer';
  const listeners = new Set<(message: WireMessage) => void>();
  const queued: QueuedMessage[] = [];

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

  websocket.onopen = () => {
    for (const queuedMessage of queued) {
      websocket.send(toArrayBuffer(queuedMessage.bytes));
    }
    queued.length = 0;
  };

  websocket.onclose = () => {
    failQueuedMessages(WS_DISCONNECTED_MESSAGE);
    console.warn(
      'WebSocket disconnected; create a new transport to reconnect.',
    );
  };

  websocket.onmessage = (event) => {
    const size = event.data?.byteLength ?? 0;
    if (size === 0) return;
    try {
      const message = protocol.decode(event.data as ArrayBuffer);
      for (const listener of listeners) listener(message);
    } catch (err) {
      console.error('Failed to parse WS message:', err);
    }
  };

  return {
    send(type, header, payload) {
      const encoded = protocol.encode(type, header, payload);
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.send(toArrayBuffer(encoded));
        return;
      }
      if (websocket.readyState === WebSocket.CONNECTING) {
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
