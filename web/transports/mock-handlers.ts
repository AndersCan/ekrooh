import { createLogRingBuffer } from '../../core/logs/store';
import type { LogStore } from '../../core/logs/types';

export type MockInvokeHandler = (
  args: Record<string, unknown> | undefined,
  payload?: Uint8Array | ArrayBuffer | string | null,
) => unknown;

export function createLogsInvokeHandlers(
  store: LogStore = createLogRingBuffer(500),
): Record<string, MockInvokeHandler> {
  return {
    'logs.view': (args) => {
      const tail = args?.tail === undefined ? undefined : Number(args.tail);
      const level =
        args?.level === 'debug' ||
        args?.level === 'info' ||
        args?.level === 'warn' ||
        args?.level === 'error'
          ? args.level
          : undefined;
      const source =
        args?.source === 'backend' || args?.source === 'web'
          ? args.source
          : undefined;
      return {
        entries: store.view({
          tail: tail !== undefined && Number.isFinite(tail) ? tail : undefined,
          level,
          source,
        }),
      };
    },
    'logs.clear': () => ({ cleared: store.clear() }),
  };
}

export function createHealthInvokeHandlers(): Record<
  string,
  MockInvokeHandler
> {
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
