/** Whether transport and invoke errors may quote the server's recent log
 * lines. A diagnostic aid, not something a shipped UI should show: on in dev,
 * or when a test build opts in with `VITE_BARE_DIAGNOSTICS=true`. Pass it to
 * both `createWebSocketTransport` and `createProtocolMessenger`. */
export function diagnosticsEnabled(
  env: Record<string, string | boolean | undefined> | undefined = (
    import.meta as { env?: Record<string, string | boolean | undefined> }
  ).env,
): boolean {
  return env?.VITE_BARE_DIAGNOSTICS === 'true' || env?.DEV === true;
}
