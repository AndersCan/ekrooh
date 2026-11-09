import {
  createWebSocketTransport,
  type MessageTransport,
} from '@ekrooh/bare/transports';

let transport: MessageTransport | null = null;

const runtimeEnv = (
  import.meta as { env?: Record<string, string | boolean | undefined> }
).env;

/** Whether transport and invoke errors may carry the server's recent log
 * lines. A diagnostic aid, not something a shipped UI should show: on in dev,
 * or when a test build opts in with `VITE_BARE_DIAGNOSTICS=true` (the device
 * CI builds do). Pass the result to both `createWebSocketTransport` and
 * `createProtocolMessenger`. */
export function diagnosticsEnabled(
  env: Record<string, string | boolean | undefined> | undefined = runtimeEnv,
): boolean {
  return env?.VITE_BARE_DIAGNOSTICS === 'true' || env?.DEV === true;
}

/** Run `start` once the transport is open (or gave up). The invoke deadline
 * starts at the call, so a call made before the socket opens can time out
 * while still queued. Transports without `ready` (mock) start at once. */
export function whenReady(
  transport: Pick<MessageTransport, 'ready'>,
  start: () => void | Promise<void>,
): Promise<void> {
  return (transport.ready?.() ?? Promise.resolve()).then(start);
}

export async function getTransport(
  forcedEnv?: Record<string, string | boolean | undefined>,
): Promise<MessageTransport> {
  const env = forcedEnv ?? runtimeEnv;
  if (!forcedEnv && transport) return transport;

  let result: MessageTransport;

  if (env?.VITE_TRANSPORT_MODE === 'mock') {
    // The mock transport fakes every permission as granted and stands in for
    // the native host — it must never be used in a production build. Guard
    // hard so a stray `VITE_TRANSPORT_MODE=mock` production build fails
    // closed. Its code is still in the prod bundle: it ships in the same
    // `@ekrooh/bare/transports` entry as the WebSocket transport, so this
    // dynamic import cannot split it out.
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
    const diagnostics = diagnosticsEnabled(env);
    // Built as a variable, not a literal, so the call also type-checks
    // against a `dist/` built before the `diagnostics` option existed.
    const options = { ...(devUrl ? { url: devUrl } : {}), diagnostics };
    result = createWebSocketTransport(options);
  }

  if (!forcedEnv) transport = result;
  return result;
}
