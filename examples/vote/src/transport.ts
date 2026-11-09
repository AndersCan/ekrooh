import {
  createWebSocketTransport,
  type MessageTransport,
} from "@ekrooh/bare/transports";

/**
 * On a phone the page is served by the app backend's loopback server, so the
 * transport uses the page's own origin. From Vite it uses the dev backend on
 * this computer (scripts/dev.mjs starts it on 8080), or the port in `?backend=`
 * (the iOS Simulator debug app runs its own backend on 8082).
 */
const backend = import.meta.env.DEV
  ? new URLSearchParams(location.search).get('backend')
  : null;
const port =
  backend && /^\d{1,5}$/.test(backend)
    ? backend
    : (import.meta.env.VITE_BACKEND_PORT ?? 8080);

export const transport: MessageTransport = createWebSocketTransport(
  import.meta.env.DEV ? { url: `ws://localhost:${port}` } : {},
);
