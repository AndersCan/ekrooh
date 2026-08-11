import {
  MessageProtocol,
  MessageTypeValue,
  MessageHeader,
  WireMessage,
} from '../../core/messages';
import { MessageTransport } from '../websocket-client';

/** Sentinel prefix posted by the shell with the WebMessagePort; the mode
 * suffix tells the transport whether the WebView supports raw binary frames
 * (`:binary`, API 34+) or needs base64 strings (`:base64`). */
const SENTINEL_PREFIX = '__less_bare_port__';

declare global {
  interface Window {
    /** Injected by the embedding shell (Android host) when the bootstrap
     * bridge is available; the data path itself is a WebMessagePort. */
    BareShell?: unknown;
  }
}

type FrameMode = 'binary' | 'base64';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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
 * Android bootstrap bridge. The shell hands over a WebMessagePort on page
 * load; frames are raw `MessageProtocol` bytes in both directions (no JSON
 * envelope, no re-serialization). Frames sent before the handoff are queued.
 */
export function createBootstrapBridgeTransport(): MessageTransport {
  const protocol = new MessageProtocol();
  const listeners = new Set<(message: WireMessage) => void>();
  const queued: ArrayBuffer[] = [];
  let port: MessagePort | null = null;
  let mode: FrameMode = 'binary';

  function deliver(bytes: Uint8Array) {
    try {
      const message = protocol.decode(bytes);
      for (const listener of listeners) listener(message);
    } catch (err) {
      console.error('Failed to parse bootstrap bridge message:', err);
    }
  }

  function postFrame(frame: ArrayBuffer) {
    if (mode === 'base64') {
      port?.postMessage(encodeBase64(new Uint8Array(frame)));
    } else {
      port?.postMessage(frame);
    }
  }

  window.addEventListener('message', (event) => {
    const data = (event as MessageEvent).data;
    if (typeof data !== 'string' || !data.startsWith(SENTINEL_PREFIX)) {
      return;
    }
    const remotePort = (event as MessageEvent).ports?.[0];
    if (!remotePort) return;

    port = remotePort;
    mode = data.includes(':base64') ? 'base64' : 'binary';
    remotePort.onmessage = (messageEvent) => {
      const incoming = (messageEvent as MessageEvent).data;
      if (mode === 'base64') {
        if (typeof incoming === 'string') deliver(decodeBase64(incoming));
      } else if (incoming instanceof ArrayBuffer) {
        deliver(new Uint8Array(incoming));
      }
    };
    for (const frame of queued) postFrame(frame);
    queued.length = 0;
  });

  return {
    send(type: MessageTypeValue, header: MessageHeader, payload) {
      const frame = toArrayBuffer(protocol.encode(type, header, payload));
      if (port) {
        postFrame(frame);
        return;
      }
      queued.push(frame);
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
