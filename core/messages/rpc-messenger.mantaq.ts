import { Actor, RealClock, event, type Clock } from '@mantaq/core';
import { ActorMap, states } from '@mantaq/sugar';
import {
  createPendingCall,
  rejectedE,
  respondE,
  resolvedE,
  startE,
} from './pending-call';
import type {
  MessageHeader,
  PluginDispatchHeader,
  PluginInvokeRequestHeader,
} from './types';

/**
 * PROTOTYPE — side-by-side comparison against `rpc-messenger.ts`.
 *
 * One messenger machine owns one `ActorMap(factory, { autoReap })`. Each
 * in-flight `invoke` is a worker child (see `pending-call.ts`) spawned into
 * the map, keyed by requestId. The messenger passes itself into the map's
 * factory, so every worker holds it in context and EMITS `RESOLVED` /
 * `REJECTED` back to it; this machine listens (declared as inputs) and
 * resolves / rejects the pending promise from its context. `autoReap` removes
 * each worker the moment it reaches a final state — no manual `kill`, no
 * `done` subscription. `ActorMap.send` to an unknown key is a no-op, matching
 * the Map version.
 *
 * This file deliberately contains exactly one `new Actor` (the invoke
 * machine) and one `new ActorMap`; per-request workers are the map's dynamic
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
  resolve: (header: MessageHeader) => void;
  reject: (reason?: unknown) => void;
}>();

type Pending = {
  resolve: (header: MessageHeader) => void;
  reject: (reason?: unknown) => void;
};

type MessengerContext = {
  pending: Record<string, Pending>;
};

export function createProtocolMessenger(
  send: (
    request: InternalDispatchRequest,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ) => void,
  options: MessengerOptions = {},
): ProtocolMessenger {
  const clock = options.clock ?? new RealClock();

  let pending: ActorMap;
  const invoke = new Actor({
    inputs: [invokeE, respondE, resolvedE, rejectedE],
    states: [ready],
    initial: ready,
    clock,
    context: { pending: {} } as MessengerContext,
    setup: (m) => {
      m.on(ready, invokeE, (event, opts) => {
        const { requestId, requestType, timeoutMs, resolve, reject } =
          event.payload;
        const s = opts.context.get();
        opts.context.set({
          ...s,
          pending: { ...s.pending, [requestId]: { resolve, reject } },
        });
        pending.ensure(requestId);
        pending.send(requestId, startE.create({ requestType, timeoutMs }));
        return {};
      });
      m.on(ready, respondE, (event) => {
        const requestId = event.payload.header.requestId;
        if (!requestId) return {};
        pending.send(requestId, respondE.create(event.payload));
        return {};
      });
      m.on(ready, resolvedE, (event, opts) => {
        const s = opts.context.get();
        const call = s.pending[event.payload.requestId];
        if (!call) return {};
        const next = { ...s.pending };
        delete next[event.payload.requestId];
        opts.context.set({ ...s, pending: next });
        call.resolve(event.payload.header);
        return {};
      });
      m.on(ready, rejectedE, (event, opts) => {
        const s = opts.context.get();
        const call = s.pending[event.payload.requestId];
        if (!call) return {};
        const next = { ...s.pending };
        delete next[event.payload.requestId];
        opts.context.set({ ...s, pending: next });
        call.reject(event.payload.error);
        return {};
      });
    },
  });
  pending = new ActorMap(
    (requestId) => createPendingCall(requestId, invoke, clock),
    { autoReap: true },
  );

  return {
    dispatch(request, payload) {
      const requestWithId = withRequestId(request);
      send(requestWithId, payload);
      return requestWithId.requestId;
    },
    invoke(request, payload, timeoutMs = 5000) {
      const requestWithId = withRequestId(request);

      return new Promise<MessageHeader>((resolve, reject) => {
        invoke.send(
          invokeE.create({
            requestId: requestWithId.requestId,
            requestType: request.type,
            timeoutMs,
            resolve,
            reject,
          }),
        );
        send(requestWithId, payload);
      });
    },
    handleIncoming(header) {
      if (!header.requestId) return;
      invoke.send(respondE.create({ header }));
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
