import {
  createBootstrapBridgeTransport,
  createMockTransport,
  createWebSocketTransport,
  createWkWebViewBridgeTransport,
  type MessageTransport,
} from '@less/bare/transports';

let transport: MessageTransport | null = null;

export function getTransport(): MessageTransport {
  if (transport) return transport;

  const mode = (import.meta as { env?: { VITE_TRANSPORT_MODE?: string } }).env
    ?.VITE_TRANSPORT_MODE;
  if (mode === 'mock') {
    transport = createMockTransport();
  } else if (window.BareShell) {
    transport = createBootstrapBridgeTransport();
  } else if (window.webkit?.messageHandlers?.bareHost) {
    transport = createWkWebViewBridgeTransport();
  } else {
    transport = createWebSocketTransport();
  }

  return transport;
}
