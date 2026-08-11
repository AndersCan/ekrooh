import {
  MessageProtocol,
  MessageTypeValue,
  MessageHeader,
  WireMessage,
} from '../../core/messages';
import { MessageTransport } from '../websocket-client';

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        bareHost?: {
          postMessage(message: unknown): void;
        };
      };
    };
    /** Set by the page transport; called by the native shell with base64
     * frames. The shell's injected stub buffers early frames here until the
     * transport installs its handler. */
    onBareMessage?: (frame: string) => void;
    __lessBarePending?: Array<Uint8Array>;
  }
}

function decodeBase64(data: string): Uint8Array {
  const binaryString = atob(data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * iOS WKWebView bootstrap bridge. WKWebView has no `WebMessagePort`, so the
 * shell and the page exchange base64-encoded `MessageProtocol` frames:
 * outbound via `window.webkit.messageHandlers.bareHost.postMessage(base64)`,
 * inbound via an injected `window.onBareMessage(base64)` callback. The frame
 * bytes are identical to every other transport — only the carrier encodes.
 */
export function createWkWebViewBridgeTransport(): MessageTransport {
  const protocol = new MessageProtocol();
  const listeners = new Set<(message: WireMessage) => void>();

  function deliver(bytes: Uint8Array) {
    try {
      const message = protocol.decode(bytes);
      for (const listener of listeners) listener(message);
    } catch (err) {
      console.error('Failed to parse WKWebView bridge message:', err);
    }
  }

  const pending = window.__lessBarePending ?? [];
  window.__lessBarePending = pending;
  window.onBareMessage = (frame: string) => {
    try {
      deliver(decodeBase64(frame));
    } catch (err) {
      console.error('Failed to decode WKWebView bridge frame:', err);
    }
  };
  // Drain any frames the shell buffered before this transport ran. Deferred to
  // a microtask so callers can subscribe before buffered frames are delivered.
  queueMicrotask(() => {
    while (pending.length > 0) deliver(pending.shift()!);
  });

  return {
    send(type: MessageTypeValue, header: MessageHeader, payload) {
      const bytes = protocol.encode(type, header, payload);
      const frame = encodeBase64(bytes);
      window.webkit?.messageHandlers?.bareHost?.postMessage(frame);
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
