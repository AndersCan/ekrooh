import { describe, expect, it } from 'vite-plus/test';
import { Actor, VirtualClock, event, type AnyActor } from '@mantaq/core';
import { ActorMap, states } from '@mantaq/sugar';
import {
  armE,
  createPendingCall,
  rejectedE,
  respondE,
  resolvedE,
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
  const parent = new Actor({
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
  const map = new ActorMap(parent);
  const worker = (requestId: string): AnyActor =>
    createPendingCall(requestId, 'INVOKE_REQUEST', 1000, clock);
  return { clock, map, received, worker };
}

describe('createPendingCall', () => {
  it('arms into awaiting', () => {
    const { clock, map, worker } = harness();
    const w = worker('r1');
    map.spawn('r1', () => w);
    expect(w.snapshot().path[0]).toBe('idle');

    map.send('r1', armE.create());
    expect(w.snapshot().path[0]).toBe('awaiting');
    expect(clock.hasPending()).toBe(true);
  });

  it('emits RESOLVED to the parent on response and cancels the timer', () => {
    const { clock, map, received, worker } = harness();
    const w = worker('r1');
    map.spawn('r1', () => w);
    map.send('r1', armE.create());
    map.send('r1', respondE.create({ header: response('r1') }));

    expect(w.snapshot().path[0]).toBe('resolved');
    expect(clock.hasPending()).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('RESOLVED');
    expect(received[0]?.payload?.requestId).toBe('r1');
  });

  it('emits REJECTED to the parent on timeout with the Map-compatible error text', () => {
    const { clock, map, received, worker } = harness();
    const w = worker('r1');
    map.spawn('r1', () => w);
    map.send('r1', armE.create());
    clock.advance(1001);

    expect(w.snapshot().path[0]).toBe('timedOut');
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('REJECTED');
    expect((received[0]?.payload?.error as Error).message).toBe(
      'invoke timeout for INVOKE_REQUEST (r1)',
    );
  });

  it('ignores a response after timing out (final state blocks dispatch)', () => {
    const { clock, map, received, worker } = harness();
    const w = worker('r1');
    map.spawn('r1', () => w);
    map.send('r1', armE.create());
    clock.advance(1001);
    map.send('r1', respondE.create({ header: response('r1') }));

    expect(w.snapshot().path[0]).toBe('timedOut');
    expect(received).toHaveLength(1);
  });
});
