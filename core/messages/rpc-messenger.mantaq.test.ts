import { describe, expect, it, vi } from 'vite-plus/test';
import { VirtualClock } from '@mantaq/core';
import { createProtocolMessenger } from './rpc-messenger.mantaq';
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

function invokeRequest() {
  return {
    type: 'INVOKE_REQUEST' as const,
    pluginId: 'core.health',
    event: 'health.ping',
    args: {},
  };
}

describe('createProtocolMessenger (mantaq prototype)', () => {
  it('dispatch assigns and returns a request id', () => {
    const send = vi.fn();
    const messenger = createProtocolMessenger(send);
    const id = messenger.dispatch({
      type: 'DISPATCH',
      pluginId: 'core.health',
      event: 'health.ping',
      args: {},
    });
    expect(typeof id).toBe('string');
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.requestId).toBe(id);
  });

  it('invoke resolves when the matching response arrives', async () => {
    const send = vi.fn();
    const messenger = createProtocolMessenger(send);
    const promise = messenger.invoke(invokeRequest());
    const request = send.mock.calls[0]?.[0];
    messenger.handleIncoming(response(request?.requestId));
    const header = await promise;
    expect(header.type).toBe('INVOKE_RESPONSE');
  });

  it('invoke rejects on timeout (virtual clock) and forgets the pending call', async () => {
    const clock = new VirtualClock();
    const send = vi.fn();
    const messenger = createProtocolMessenger(send, { clock });
    const promise = messenger.invoke(invokeRequest(), null, 1000);

    const assertion = expect(promise).rejects.toThrow(/invoke timeout/);
    clock.advance(1001);
    await assertion;

    // A late response for the timed-out request is ignored: the worker was
    // reaped on its final state, so `ActorMap.send` is a no-op.
    const request = send.mock.calls[0]?.[0];
    messenger.handleIncoming(response(request?.requestId));
    expect(clock.hasPending()).toBe(false);
  });

  it('resolves before a late timeout fires and cancels the pending timer', async () => {
    const clock = new VirtualClock();
    const send = vi.fn();
    const messenger = createProtocolMessenger(send, { clock });
    const promise = messenger.invoke(invokeRequest(), null, 1000);

    const request = send.mock.calls[0]?.[0];
    messenger.handleIncoming(response(request?.requestId));

    const header = await promise;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(clock.hasPending()).toBe(false);
    clock.advance(5000);
    expect(clock.hasPending()).toBe(false);
  });

  it('resolves concurrent invokes independently (one worker per request)', async () => {
    const clock = new VirtualClock();
    const send = vi.fn();
    const messenger = createProtocolMessenger(send, { clock });

    const first = messenger.invoke(invokeRequest(), null, 1000);
    const second = messenger.invoke(invokeRequest(), null, 2000);
    const requests = send.mock.calls.map((call) => call[0]);

    // The second request resolves first; the first stays pending until its
    // own timeout.
    messenger.handleIncoming(response(requests[1]?.requestId));
    const header = await second;
    expect(header.type).toBe('INVOKE_RESPONSE');

    clock.advance(1001);
    await expect(first).rejects.toThrow(/invoke timeout/);
  });

  it('ignores responses with unknown request ids', () => {
    const send = vi.fn();
    const messenger = createProtocolMessenger(send);
    expect(() =>
      messenger.handleIncoming(response('unknown-id')),
    ).not.toThrow();
  });
});
