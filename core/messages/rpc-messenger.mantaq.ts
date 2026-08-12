import { Actor, RealClock, event, type Clock } from '@mantaq/core';
import { ActorMap, states } from '@mantaq/sugar';
import type {
  MessageHeader,
  PluginDispatchHeader,
  PluginInvokeRequestHeader,
} from './types';

/**
 * PROTOTYPE — side-by-side comparison against `rpc-messenger.ts`.
 *
 * The Map-backed pending-call table is modeled with mantaq instead: each
 * in-flight `invoke` spawns one worker child in an `ActorMap`, keyed by
 * requestId. The worker is the request lifecycle — `idle` → `awaiting` →
 * `resolved` | `timedOut` (both final). The timeout is the worker's `awaiting`
 * effect (a `clock.setTimeout` on the injected clock, auto-cancelled by the
 * abort signal on resolution), so VirtualClock tests advance time instead of
 * `vi.useFakeTimers()`. `handleIncoming` routes a response to the matching
 * worker via `ActorMap.send` — a no-op for unknown ids, matching the Map
 * version. A worker's `done` (final state entry) reaps it from the map.
 *
 * The worker starts `idle` and the messenger sends `arm` after spawning:
 * mantaq runs effects on state ENTRY only — the initial state's effect never
 * runs — so the timeout timer is armed by the transition into `awaiting`, not
 * by construction. The promise bridge (`resolve`/`reject`) rides in worker
 * context and is invoked from the transitions themselves; effects would be
 * the wrong home because mantaq never runs effects on final states.
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

const { idle, awaiting, resolved, timedOut } = states(
  'idle',
  'awaiting',
  'resolved',
  'timedOut',
);
const resolvedFinal = resolved.final();
const timedOutFinal = timedOut.final();

const arm = event('ARM')();
const respond = event('RESPOND')<{ header: MessageHeader }>();
const timedOutEvent = event('TIMED_OUT')();

type PendingContext = {
  requestType: string;
  resolve: (header: MessageHeader) => void;
  reject: (reason?: unknown) => void;
};

function createPendingCall(
  requestId: string,
  timeoutMs: number,
  clock: Clock,
  context: PendingContext,
) {
  return new Actor({
    inputs: [arm, respond],
    internal: [timedOutEvent],
    states: [idle, awaiting, resolvedFinal, timedOutFinal],
    initial: idle,
    clock,
    context,
    setup: (m) => {
      m.on(idle, arm, () => ({ state: awaiting }));
      m.effect(awaiting, ({ signal, clock, emit }) => {
        clock.setTimeout(timeoutMs, () => emit(timedOutEvent.create()), {
          signal,
        });
      });
      m.on(awaiting, respond, (event, opts) => {
        opts!.context.get().resolve(event.payload.header);
        return { state: resolvedFinal };
      });
      m.on(awaiting, timedOutEvent, (_event, opts) => {
        const s = opts!.context.get();
        s.reject(
          new Error(`invoke timeout for ${s.requestType} (${requestId})`),
        );
        return { state: timedOutFinal };
      });
    },
  });
}

export function createProtocolMessenger(
  send: (
    request: InternalDispatchRequest,
    payload?: Uint8Array | ArrayBuffer | string | null,
  ) => void,
  options: MessengerOptions = {},
): ProtocolMessenger {
  const clock = options.clock ?? new RealClock();
  const pending = new ActorMap();

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
        const worker = createPendingCall(requestId, timeoutMs, clock, {
          requestType: request.type,
          resolve: resolvePromise,
          reject: rejectPromise,
        });
        pending.spawn(requestId, () => worker);
        worker.on('done', () => pending.kill(requestId));
        pending.send(requestId, arm.create());
        send(requestWithId, payload);
      });
    },
    handleIncoming(header) {
      if (!header.requestId) return;
      pending.send(header.requestId, respond.create({ header }));
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
