import {
  createWebSocketTransport,
  type MessageTransport,
} from '@ekrooh/bare/transports';

/**
 * On a phone the page is served by the app backend's loopback server, so the
 * transport uses the page's own origin. In the browser the page comes from
 * Vite, so point at the dev backend (scripts/dev.mjs starts it on 8080).
 */
export const transport: MessageTransport = createWebSocketTransport(
  import.meta.env.DEV
    ? { url: `ws://localhost:${import.meta.env.VITE_BACKEND_PORT ?? 8080}` }
    : {},
);
