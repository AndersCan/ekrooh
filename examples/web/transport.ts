import {
  createBootstrapBridgeTransport,
  createMockTransport,
  createWebSocketTransport,
  type MessageTransport,
} from '@less/bare/transports';

let transport: MessageTransport | null = null;

export function getTransport(): MessageTransport {
  if (transport) return transport;

  const mode = (import.meta as { env?: { VITE_TRANSPORT_MODE?: string } }).env
    ?.VITE_TRANSPORT_MODE;
  if (mode === 'mock') {
    transport = createMockTransport();
  } else if (window.NativeBridge) {
    transport = createBootstrapBridgeTransport();
  } else {
    transport = createWebSocketTransport();
  }

  return transport;
}
