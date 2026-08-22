import {
  createWebSocketTransport,
  type MessageTransport,
} from '@ekrooh/bare/transports';

let transport: MessageTransport | null = null;

const runtimeEnv = (
  import.meta as { env?: Record<string, string | boolean | undefined> }
).env;

export async function getTransport(
  forcedEnv?: Record<string, string | boolean | undefined>,
): Promise<MessageTransport> {
  const env = forcedEnv ?? runtimeEnv;
  if (!forcedEnv && transport) return transport;

  let result: MessageTransport;

  if (env?.VITE_TRANSPORT_MODE === 'mock') {
    // The mock transport fakes every permission as granted and stands in for
    // the native host — it must never ship in a production bundle. Guard hard
    // so a stray `VITE_TRANSPORT_MODE=mock` production build fails closed, and
    // load it via a dynamic import so it tree-shakes out of prod bundles.
    if (env?.PROD) {
      throw new Error(
        'Mock transport is unavailable in production builds (VITE_TRANSPORT_MODE=mock is dev-only)',
      );
    }
    const { createMockTransport } = await import('@ekrooh/bare/transports');
    result = createMockTransport();
  } else {
    // On-device the page is served by the worklet's loopback server, so the
    // transport defaults to the same origin. Browser dev is cross-origin (the
    // Vite dev server), so point at the dev backend explicitly.
    const devUrl =
      (env?.VITE_BARE_WS_URL as string | undefined) ??
      (env?.DEV ? 'ws://localhost:8080' : undefined);
    result = createWebSocketTransport(devUrl ? { url: devUrl } : {});
  }

  if (!forcedEnv) transport = result;
  return result;
}
