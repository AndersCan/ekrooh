import { Actor, event, type AnyActor, type Clock } from '@mantaq/core';
import { states, withTimeout } from '@mantaq/sugar';
import type { MessageHeader } from './types';

/**
 * One pending-RPC handler — a dynamic child of the messenger's ActorMap. Its
 * lifecycle is `idle` → `awaiting` → `resolved` | `timedOut` (both final). It
 * owns its outcome and reports it by EMITTING `settled` as a declared output
 * on its terminal transition; the messenger wires that output back to itself
 * (`onOutput` in the map factory). The timeout is the `awaiting` effect via
 * `withTimeout`, abort-safe on the injected clock. The map's `autoReap`
 * removes the handler the moment it reaches a final state.
 */

const { idle, awaiting, resolved, timedOut } = states(
  'idle',
  'awaiting',
  { name: 'resolved', final: true },
  { name: 'timedOut', final: true },
);

export const startE = event('START')<{ timeoutMs: number }>();
export const respondE = event('RESPOND')<{ header: MessageHeader }>();
export const settledE = event('SETTLED')<{
  requestId: string;
  status: 'answered' | 'timedOut';
  header?: MessageHeader;
}>();
const timedOutE = event('TIMED_OUT')();

type PendingContext = {
  timeoutMs?: number;
};

export function createPendingCall(requestId: string, clock: Clock): AnyActor {
  return new Actor({
    inputs: [startE, respondE],
    outputs: [settledE],
    internal: [timedOutE],
    states: [idle, awaiting, resolved, timedOut],
    initial: idle,
    clock,
    context: {} as PendingContext,
    setup: (m) => {
      m.on(idle, startE, (event, opts) => {
        const s = opts.context.get();
        s.timeoutMs = event.payload.timeoutMs;
        opts.context.set(s);
        return { state: awaiting };
      });
      m.effect(awaiting, (input) => {
        withTimeout(input.context.get().timeoutMs ?? 5000, input, () =>
          timedOutE.create(),
        );
      });
      m.on(awaiting, respondE, (event) => ({
        state: resolved,
        emit: [
          settledE.create({
            requestId,
            status: 'answered',
            header: event.payload.header,
          }),
        ],
      }));
      m.on(awaiting, timedOutE, () => ({
        state: timedOut,
        emit: [settledE.create({ requestId, status: 'timedOut' })],
      }));
    },
  });
}
