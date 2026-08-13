import { Actor, event, type AnyActor, type Clock } from '@mantaq/core';
import { states } from '@mantaq/sugar';
import type { MessageHeader } from './types';

/**
 * One pending-RPC worker — a dynamic child of the messenger's ActorMap. Its
 * lifecycle is `idle` → `awaiting` → `resolved` | `timedOut` (both final). It
 * never touches the promise: the terminal transitions EMIT `RESOLVED` /
 * `REJECTED` outputs, which the ActorMap routes to the messenger machine to
 * handle. The timeout is the `awaiting` effect on the injected clock,
 * auto-cancelled by the abort signal on resolution. It starts `idle` and is
 * armed via `ARM` because mantaq runs effects on state ENTRY only.
 */

const { idle, awaiting, resolved, timedOut } = states(
  'idle',
  'awaiting',
  'resolved',
  'timedOut',
);
const resolvedFinal = resolved.final();
const timedOutFinal = timedOut.final();

export const armE = event('ARM')();
export const respondE = event('RESPOND')<{ header: MessageHeader }>();
const timedOutE = event('TIMED_OUT')();
export const resolvedE = event('RESOLVED')<{
  requestId: string;
  header: MessageHeader;
}>();
export const rejectedE = event('REJECTED')<{
  requestId: string;
  error: unknown;
}>();

type PendingContext = {
  requestType: string;
};

export function createPendingCall(
  requestId: string,
  requestType: string,
  timeoutMs: number,
  clock: Clock,
): AnyActor {
  return new Actor({
    inputs: [armE, respondE],
    outputs: [resolvedE, rejectedE],
    internal: [timedOutE],
    states: [idle, awaiting, resolvedFinal, timedOutFinal],
    initial: idle,
    clock,
    context: { requestType } as PendingContext,
    setup: (m) => {
      m.on(idle, armE, () => ({ state: awaiting }));
      m.effect(awaiting, ({ signal, clock, emit }) => {
        clock.setTimeout(timeoutMs, () => emit(timedOutE.create()), { signal });
      });
      m.on(awaiting, respondE, (event) => ({
        state: resolvedFinal,
        emit: [resolvedE.create({ requestId, header: event.payload.header })],
      }));
      m.on(awaiting, timedOutE, (_event, opts) => ({
        state: timedOutFinal,
        emit: [
          rejectedE.create({
            requestId,
            error: new Error(
              `invoke timeout for ${opts.context.get().requestType} (${requestId})`,
            ),
          }),
        ],
      }));
    },
  });
}
