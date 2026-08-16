import { describe, expect, it } from 'vite-plus/test';
import { VirtualClock } from '@mantaq/core';
import { ActorMap, onOutput } from '@mantaq/sugar';
import { createPendingCall, respondE, settledE, startE } from './pending-call';
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

function harness() {
  const clock = new VirtualClock();
  const received: unknown[] = [];
  const worker = createPendingCall('r1', clock);
  onOutput(worker, (e) => received.push(e));
  return { clock, received, worker };
}

describe('createPendingCall', () => {
  it('arms into awaiting on START and registers the timeout timer', () => {
    const { clock, worker } = harness();
    expect(worker.snapshot().path[0]).toBe('idle');

    worker.send(startE.create({ timeoutMs: 1000 }));
    expect(worker.snapshot().path[0]).toBe('awaiting');
    expect(clock.hasPending()).toBe(true);
  });

  it('emits SETTLED answered on response and cancels the timer', () => {
    const { clock, received, worker } = harness();
    worker.send(startE.create({ timeoutMs: 1000 }));
    worker.send(respondE.create({ header: response('r1') }));

    expect(worker.snapshot().path[0]).toBe('resolved');
    expect(clock.hasPending()).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'SETTLED',
      payload: { requestId: 'r1', status: 'answered' },
    });
  });

  it('emits SETTLED timedOut on timeout', () => {
    const { clock, received, worker } = harness();
    worker.send(startE.create({ timeoutMs: 1000 }));
    clock.advance(1001);

    expect(worker.snapshot().path[0]).toBe('timedOut');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'SETTLED',
      payload: { requestId: 'r1', status: 'timedOut' },
    });
  });

  it('ignores a response after timing out (final state blocks dispatch)', () => {
    const { clock, received, worker } = harness();
    worker.send(startE.create({ timeoutMs: 1000 }));
    clock.advance(1001);
    worker.send(respondE.create({ header: response('r1') }));

    expect(worker.snapshot().path[0]).toBe('timedOut');
    expect(received).toHaveLength(1);
  });

  it('is auto-reaped by an autoReap ActorMap once it settles', () => {
    const clock = new VirtualClock();
    const map = new ActorMap((id) => createPendingCall(id, clock), {
      autoReap: true,
    });

    map.ensure('r1');
    expect(map.has('r1')).toBe(true);

    map.send('r1', startE.create({ timeoutMs: 1000 }));
    map.send('r1', respondE.create({ header: response('r1') }));
    expect(map.has('r1')).toBe(false);
  });
});
