import {
  createWebSocketTransport,
  type MessageTransport,
} from '@ekrooh/bare/transports';

const env = (import.meta as { env?: Record<string, string | undefined> }).env;

/**
 * On-device the page is served by the worklet's loopback server, so the
 * transport defaults to the page's own origin (`ws://location.host`). Browser
 * dev is cross-origin (the Vite dev server), so point at the dev backend
 * explicitly — override with `VITE_BARE_WS_URL` when the backend is not on
 * the default dev port.
 */
const devUrl =
  env?.VITE_BARE_WS_URL ?? (env?.DEV ? 'ws://localhost:8080' : undefined);

export const transport: MessageTransport = createWebSocketTransport(
  devUrl ? { url: devUrl } : {},
);
