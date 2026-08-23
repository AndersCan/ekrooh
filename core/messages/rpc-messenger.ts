import {
  MessageHeader,
  PluginDispatchHeader,
  PluginInvokeRequestHeader,
} from './types';

type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;

type InternalDispatchRequest =
  | (PluginDispatchHeader & { requestId: string })
  | (PluginInvokeRequestHeader & { requestId: string });

export type DispatchRequest = DistributiveOmit<
  PluginDispatchHeader,
  'requestId'
>;
export type InvokeRequest = DistributiveOmit<
  PluginInvokeRequestHeader,
  'requestId'
>;

export interface ProtocolMessenger {
  dispatch(
    request: DispatchRequest,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ): string;
  invoke(
    request: InvokeRequest,
    payload?: Uint8Array | ArrayBuffer | string | null,
    timeoutMs?: number,
  ): Promise<MessageHeader>;
  handleIncoming(header: MessageHeader): void;
}

/** Hard ceiling on concurrently in-flight invokes. Above this, the oldest call
 * is dropped (its timer cleared and promise rejected) so a flood of requests
 * cannot grow the pending map without bound. */
const MAX_CONCURRENT_INVOKES = 1024;

export function createProtocolMessenger(
  send: (
    request: InternalDispatchRequest,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ) => void,
): ProtocolMessenger {
  const pending = new Map<
    string,
    {
      pluginId: string;
      event: string;
      resolve: (value: MessageHeader) => void;
      reject: (reason?: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  return {
    dispatch(request, payload) {
      const requestWithId = withRequestId(request);
      send(requestWithId, payload);
      return requestWithId.requestId;
    },
    invoke(request, payload, timeoutMs = 5000) {
      const requestWithId = withRequestId(request);
      const { requestId, pluginId, event } = requestWithId;

      return new Promise<MessageHeader>((resolvePromise, rejectPromise) => {
        const fail = async (reason: string): Promise<void> => {
          console.error(`[invoke] ${reason}`);
          const tail = await serverLogTail();
          rejectPromise(
            new Error(tail ? `${reason}; recent logs: ${tail}` : reason),
          );
        };
        const timer = setTimeout(() => {
          pending.delete(requestId);
          void fail(`invoke timeout for ${request.type} (${requestId})`);
        }, timeoutMs);

        if (pending.size >= MAX_CONCURRENT_INVOKES) {
          const oldest = pending.keys().next().value;
          if (oldest !== undefined) {
            const dropped = pending.get(oldest);
            if (dropped) {
              clearTimeout(dropped.timer);
              dropped.reject(
                new Error(
                  `invoke dropped: too many concurrent invokes (${requestId})`,
                ),
              );
            }
            pending.delete(oldest);
          }
        }

        pending.set(requestId, {
          pluginId,
          event,
          resolve: resolvePromise,
          reject: rejectPromise,
          timer,
        });
        send(requestWithId, payload);
      });
    },
    handleIncoming(header) {
      if (!header.requestId) {
        try {
          console.debug(
            `[rpc] incoming ${header.type} without a requestId; uncorrelatable, dropping`,
          );
        } catch {
          // Observability only — never throw into the caller.
        }
        return;
      }

      const pendingCall = pending.get(header.requestId);
      if (!pendingCall) {
        try {
          console.debug(
            `[rpc] ${header.type} for unknown/stale requestId (${header.requestId}); dropping`,
          );
        } catch {
          // Observability only — never throw into the caller.
        }
        return;
      }

      if (
        header.type === 'INVOKE_RESPONSE' &&
        (header.pluginId !== pendingCall.pluginId ||
          header.event !== pendingCall.event)
      ) {
        try {
          console.debug(
            `[rpc] RESPONSE for ${header.requestId} mismatches pending ` +
              `${pendingCall.pluginId}.${pendingCall.event} ` +
              `(got ${header.pluginId}.${header.event}); dropping`,
          );
        } catch {
          // Observability only — never throw into the caller.
        }
        return;
      }

      clearTimeout(pendingCall.timer);
      pending.delete(header.requestId);
      pendingCall.resolve(header);
    },
  };
}

function createRequestId() {
  // CSPRNG-backed (not Math.random): unguessable, collision-resistant ids.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const rand = bytes.reduce((acc, b) => acc + b.toString(36), '').slice(0, 22);
  return `${Date.now().toString(36)}-${rand}`;
}

function withRequestId<T extends object>(
  request: T,
): T & { requestId: string } {
  return { ...request, requestId: createRequestId() };
}

/** Cap on log lines appended to an invoke-timeout rejection. The string can
 * land in an XCTest accessibility label, so keep it bounded. */
const INVOKE_TAIL_LINES = 20;
const INVOKE_TAIL_TIMEOUT_MS = 2000;

/**
 * Fetches a short tail of the loopback server's log (worklet + webview console)
 * to enrich an invoke timeout with whatever the peer just saw. Best-effort:
 * only attempted in a browser/webview context where `fetch` and a same-origin
 * `/logs` route exist; never throws into the caller. Returns null when nothing
 * can be learned.
 */
async function serverLogTail(): Promise<string | null> {
  if (typeof fetch !== 'function' || typeof window === 'undefined') {
    return null;
  }
  try {
    const response = await Promise.race([
      fetch('/logs?tail=50&format=text'),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), INVOKE_TAIL_TIMEOUT_MS),
      ),
    ]);
    if (response === null || !response.ok) return null;
    const text = await response.text();
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-INVOKE_TAIL_LINES);
    return lines.length > 0 ? lines.join(' | ') : null;
  } catch {
    return null;
  }
}
