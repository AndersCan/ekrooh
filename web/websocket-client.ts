import {
  MessageHeader,
  MessageProtocol,
  MessageType,
  MessageTypeValue,
  WireMessage,
} from '../core/messages';

const protocol = new MessageProtocol();
const WS_DISCONNECTED_MESSAGE =
  'WebSocket disconnected before request could be sent';

type QueuedMessage = {
  bytes: Uint8Array;
  header: MessageHeader;
};

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
  const websocket = new WebSocket(url);
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
            code: 'TRANSPORT_ERROR',
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
      websocket.send(queuedMessage.bytes);
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
        websocket.send(encoded);
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
