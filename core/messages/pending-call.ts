import { Actor, event, type AnyActor, type Clock } from '@mantaq/core';
import { states } from '@mantaq/sugar';
import type { MessageHeader } from './types';

/**
 * One pending-RPC worker — a dynamic child of the messenger's ActorMap. Its
 * lifecycle is `idle` → `awaiting` → `resolved` | `timedOut` (both final).
 * The messenger passes itself into the factory, so the worker holds it in
 * context and EMITS `RESOLVED` / `REJECTED` back to it from its final-state
 * effects — the invoke machine listens and resolves / rejects the promise
 * (context can hold anything, including an actor). The timeout is the
 * `awaiting` effect on the injected clock, auto-cancelled by the abort signal
 * on resolution. The map's `autoReap` removes the worker on final state.
 */

const { idle, awaiting, resolved, timedOut } = states(
  'idle',
  'awaiting',
  { name: 'resolved', final: true },
  { name: 'timedOut', final: true },
);

export const startE = event('START')<{
  requestType: string;
  timeoutMs: number;
}>();
export const respondE = event('RESPOND')<{ header: MessageHeader }>();
export const resolvedE = event('RESOLVED')<{
  requestId: string;
  header: MessageHeader;
}>();
export const rejectedE = event('REJECTED')<{
  requestId: string;
  error: unknown;
}>();
const timedOutE = event('TIMED_OUT')();

type PendingContext = {
  invoke: AnyActor;
  requestType: string;
  timeoutMs: number;
  header?: MessageHeader;
};

export function createPendingCall(
  requestId: string,
  invoke: AnyActor,
  clock: Clock,
): AnyActor {
  return new Actor({
    inputs: [startE, respondE],
    internal: [timedOutE],
    states: [idle, awaiting, resolved, timedOut],
    initial: idle,
    clock,
    context: { invoke } as PendingContext,
    setup: (m) => {
      m.on(idle, startE, (event, opts) => {
        const s = opts.context.get();
        opts.context.set({
          ...s,
          requestType: event.payload.requestType,
          timeoutMs: event.payload.timeoutMs,
        });
        return { state: awaiting };
      });
      m.effect(awaiting, ({ signal, clock, emit, context }) => {
        clock.setTimeout(
          context.get().timeoutMs,
          () => emit(timedOutE.create()),
          { signal },
        );
      });
      m.on(awaiting, respondE, (event, opts) => {
        opts.context.set({
          ...opts.context.get(),
          header: event.payload.header,
        });
        return { state: resolved };
      });
      m.on(awaiting, timedOutE, () => ({ state: timedOut }));
      m.effect(resolved, ({ context }) => {
        const s = context.get();
        s.invoke.send(resolvedE.create({ requestId, header: s.header! }));
      });
      m.effect(timedOut, ({ context }) => {
        const s = context.get();
        s.invoke.send(
          rejectedE.create({
            requestId,
            error: new Error(
              `invoke timeout for ${s.requestType} (${requestId})`,
            ),
          }),
        );
      });
    },
  });
}
