import { WireMessage } from '../../core/messages';
import { MessageTransport } from '../websocket-client';

type InjectedBridge = {
  send(message: string): void;
};

type NativeEnvelope = {
  type: number;
  header: Record<string, unknown>;
  payloadBase64?: string | null;
};

declare global {
  interface Window {
    /** Injected by the embedding shell when present; not used by browser dev. */
    NativeBridge?: InjectedBridge;
    /** Injected callback: framed messages from backend → UI (same shape as WebSocket decode). */
    onBackendMessage?: (msg: {
      type: number;
      header: Record<string, unknown>;
      payload?: string;
    }) => void;
  }
}

function decodeBase64(data: string) {
  const binaryString = atob(data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function createBootstrapBridgeTransport(): MessageTransport {
  const listeners = new Set<(message: WireMessage) => void>();

  window.onBackendMessage = (msg) => {
    const payload = msg.payload ? decodeBase64(msg.payload) : new Uint8Array(0);
    const message: WireMessage = {
      type: msg.type as WireMessage['type'],
      header: msg.header as WireMessage['header'],
      payload,
    };
    for (const listener of listeners) listener(message);
  };

  return {
    send(type, header, payload) {
      let payloadBase64: string | null = null;
      if (payload) {
        const bytes =
          typeof payload === 'string'
            ? new TextEncoder().encode(payload)
            : payload instanceof ArrayBuffer
              ? new Uint8Array(payload)
              : payload;
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        payloadBase64 = btoa(binary);
      }
      const envelope: NativeEnvelope = {
        type,
        header: header as Record<string, unknown>,
        payloadBase64,
      };
      window.NativeBridge?.send(JSON.stringify(envelope));
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
