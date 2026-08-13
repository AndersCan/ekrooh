import { describe, expect, it } from 'vite-plus/test';
import { Actor, VirtualClock, type AnyActor } from '@mantaq/core';
import { ActorMap, states } from '@mantaq/sugar';
import {
  createPendingCall,
  rejectedE,
  respondE,
  resolvedE,
  startE,
} from './pending-call';
import type { MessageHeader } from './types';

function response(requestId: string): MessageHeader {
  return {
    type: 'INVOKE_RESPONSE',
    pluginId: 'core.health',
    event: 'health.ping',
    requestId,
    result: {},
  };
}

type Received = { type: string; payload?: Record<string, unknown> };

function harness() {
  const clock = new VirtualClock();
  const received: Received[] = [];
  const { ready } = states('ready');
  const invoke = new Actor({
    inputs: [resolvedE, rejectedE],
    states: [ready],
    initial: ready,
    setup: (m) => {
      m.on(ready, resolvedE, (e) => {
        received.push(e as Received);
        return {};
      });
      m.on(ready, rejectedE, (e) => {
        received.push(e as Received);
        return {};
      });
    },
  });
  const start = () =>
    startE.create({ requestType: 'INVOKE_REQUEST', timeoutMs: 1000 });
  const worker = createPendingCall('r1', invoke as AnyActor, clock);
  return { clock, invoke, received, start, worker };
}

describe('createPendingCall', () => {
  it('arms into awaiting on START and registers the timeout timer', () => {
    const { clock, start, worker } = harness();
    expect(worker.snapshot().path[0]).toBe('idle');

    worker.send(start());
    expect(worker.snapshot().path[0]).toBe('awaiting');
    expect(clock.hasPending()).toBe(true);
  });

  it('emits RESOLVED to the invoke actor on response and cancels the timer', () => {
    const { clock, received, start, worker } = harness();
    worker.send(start());
    worker.send(respondE.create({ header: response('r1') }));

    expect(worker.snapshot().path[0]).toBe('resolved');
    expect(clock.hasPending()).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('RESOLVED');
    expect(received[0]?.payload?.requestId).toBe('r1');
  });

  it('emits REJECTED with the Map-compatible error on timeout', () => {
    const { clock, received, start, worker } = harness();
    worker.send(start());
    clock.advance(1001);

    expect(worker.snapshot().path[0]).toBe('timedOut');
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('REJECTED');
    expect((received[0]?.payload?.error as Error).message).toBe(
      'invoke timeout for INVOKE_REQUEST (r1)',
    );
  });

  it('ignores a response after timing out (final state blocks dispatch)', () => {
    const { clock, received, start, worker } = harness();
    worker.send(start());
    clock.advance(1001);
    worker.send(respondE.create({ header: response('r1') }));

    expect(worker.snapshot().path[0]).toBe('timedOut');
    expect(received).toHaveLength(1);
  });

  it('is auto-reaped by an autoReap ActorMap once it reaches a final state', () => {
    const { clock, invoke, start } = harness();
    const map = new ActorMap(
      (id) => createPendingCall(id, invoke as AnyActor, clock),
      { autoReap: true },
    );

    map.ensure('r1');
    expect(map.has('r1')).toBe(true);

    map.send('r1', start());
    map.send('r1', respondE.create({ header: response('r1') }));
    expect(map.has('r1')).toBe(false);
  });
});
