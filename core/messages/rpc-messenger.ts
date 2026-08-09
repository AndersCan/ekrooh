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

export function createProtocolMessenger(
  send: (
    request: InternalDispatchRequest,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ) => void,
): ProtocolMessenger {
  const pending = new Map<
    string,
    {
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
      const { requestId } = requestWithId;

      return new Promise<MessageHeader>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          rejectPromise(
            new Error(`invoke timeout for ${request.type} (${requestId})`),
          );
        }, timeoutMs);

        pending.set(requestId, {
          resolve: resolvePromise,
          reject: rejectPromise,
          timer,
        });
        send(requestWithId, payload);
      });
    },
    handleIncoming(header) {
      if (!header.requestId) return;

      const pendingCall = pending.get(header.requestId);
      if (!pendingCall) return;

      clearTimeout(pendingCall.timer);
      pending.delete(header.requestId);
      pendingCall.resolve(header);
    },
  };
}

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function withRequestId<T extends object>(
  request: T,
): T & { requestId: string } {
  return { ...request, requestId: createRequestId() };
}
