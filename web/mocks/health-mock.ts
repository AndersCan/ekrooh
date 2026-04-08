export type MockInvokeHandler = (
  args: Record<string, unknown> | undefined,
  payload?: Uint8Array | ArrayBuffer | string | null,
) => unknown;

export function createHealthInvokeHandlers(): Record<string, MockInvokeHandler> {
  return {
    'health.ping': (args) => ({
      message: String(args?.message ?? 'pong'),
      ts: Date.now(),
    }),
    'health.payloadEcho': (args, payload) => {
      const payloadSize =
        typeof payload === 'string'
          ? new TextEncoder().encode(payload).byteLength
          : payload instanceof ArrayBuffer
            ? payload.byteLength
            : (payload?.byteLength ?? 0);
      return {
        label: String(args?.label ?? 'payload'),
        payloadSize,
      };
    },
    'health.roundtrip': () => ({ pong: true, ts: Date.now() }),
  };
}
