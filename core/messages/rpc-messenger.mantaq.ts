import { Actor, RealClock, event, type Clock } from '@mantaq/core';
import { ActorMap, onOutput, states } from '@mantaq/sugar';
import { createPendingCall, respondE, settledE, startE } from './pending-call';
import type {
  MessageHeader,
  PluginDispatchHeader,
  PluginInvokeRequestHeader,
} from './types';

/**
 * PROTOTYPE — side-by-side comparison against `rpc-messenger.ts`.
 *
 * One messenger machine owns one `ActorMap(factory, { autoReap: true })`. Each
 * in-flight `invoke` is a request handler child (see `pending-call.ts`), keyed
 * by requestId. The handler owns its outcome and reports it by emitting
 * `settled` as a DECLARED OUTPUT on its terminal transition; the map factory
 * wires that output back into this machine with one `onOutput` line. The
 * machine re-emits it as `done`; the shell's `onOutput(manager, …)` resolves /
 * rejects the pending promise. A handler that dies into `__error` emits no
 * `settled` — the factory's `done` guard rejects instead, so the invoke never
 * hangs. No promise ever lives in the machine — the promise bridge is a
 * shell-side map keyed by requestId, exactly like the Map version. `autoReap`
 * removes each handler the moment it reaches a final state (including
 * `__error`).
 * `ActorMap.send` to an unknown key is a no-op, matching the Map version.
 *
 * This file deliberately contains exactly one `new Actor` (the messenger
 * machine) and one `new ActorMap`; per-request handlers are the map's dynamic
 * children, created in `pending-call.ts`.
 */
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

export interface MessengerOptions {
  clock?: Clock;
}

const { ready } = states('ready');

const invokeE = event('INVOKE')<{
  requestId: string;
  requestType: string;
  timeoutMs: number;
}>();

type Settled = {
  requestId: string;
  status: 'answered' | 'timedOut';
  header?: MessageHeader;
};

const doneE = event('DONE')<Settled>();

export function createProtocolMessenger(
  send: (
    request: InternalDispatchRequest,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ) => void,
  options: MessengerOptions = {},
): ProtocolMessenger {
  const clock = options.clock ?? new RealClock();

  type Pending = {
    requestType: string;
    resolve: (header: MessageHeader) => void;
    reject: (reason?: unknown) => void;
  };
  const pending = new Map<string, Pending>();

  let requests: ActorMap;
  const manager = new Actor({
    inputs: [invokeE, respondE, settledE],
    outputs: [doneE],
    states: [ready],
    initial: ready,
    clock,
    setup: (m) => {
      m.on(ready, invokeE, (event) => {
        const { requestId, timeoutMs } = event.payload;
        requests.ensure(requestId);
        requests.send(requestId, startE.create({ timeoutMs }));
        return {};
      });
      m.on(ready, respondE, (event) => {
        const requestId = event.payload.header.requestId;
        if (!requestId) return {};
        requests.send(requestId, respondE.create(event.payload));
        return {};
      });
      m.on(ready, settledE, (event) => ({
        emit: [doneE.create(event.payload)],
      }));
    },
  });
  requests = new ActorMap(
    (requestId) => {
      const child = createPendingCall(requestId, clock);
      onOutput(child, (e) => {
        if (settledE.is(e)) manager.send(e);
      });
      // A handler that dies into `__error` never emits `settled` — the shell
      // promise would hang. `done` still fires, and the settlement output
      // drains before this microtask runs, so a still-pending entry here
      // means the handler died unsettled: reject so the invoke never hangs.
      child.on('done', () => {
        queueMicrotask(() => {
          const call = pending.get(requestId);
          if (!call) return;
          pending.delete(requestId);
          call.reject(
            new Error(`invoke timeout for ${call.requestType} (${requestId})`),
          );
        });
      });
      return child;
    },
    { autoReap: true },
  );

  onOutput(manager, (e) => {
    if (!doneE.is(e)) return;
    const { requestId, status, header } = e.payload;
    const call = pending.get(requestId);
    if (!call) return;
    pending.delete(requestId);
    if (status === 'answered' && header) {
      call.resolve(header);
    } else {
      call.reject(
        new Error(`invoke timeout for ${call.requestType} (${requestId})`),
      );
    }
  });

  return {
    dispatch(request, payload) {
      const requestWithId = withRequestId(request);
      send(requestWithId, payload);
      return requestWithId.requestId;
    },
    invoke(request, payload, timeoutMs = 5000) {
      const requestWithId = withRequestId(request);

      return new Promise<MessageHeader>((resolve, reject) => {
        pending.set(requestWithId.requestId, {
          requestType: request.type,
          resolve,
          reject,
        });
        manager.send(
          invokeE.create({
            requestId: requestWithId.requestId,
            requestType: request.type,
            timeoutMs,
          }),
        );
        send(requestWithId, payload);
      });
    },
    handleIncoming(header) {
      if (!header.requestId) return;
      manager.send(respondE.create({ header }));
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
