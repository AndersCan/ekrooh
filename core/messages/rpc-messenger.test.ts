import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createProtocolMessenger } from './rpc-messenger';
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

afterEach(() => {
  vi.useRealTimers();
});

describe('createProtocolMessenger', () => {
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
    const promise = messenger.invoke({
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      args: {},
    });
    const request = send.mock.calls[0]?.[0];
    messenger.handleIncoming(response(request?.requestId));
    const header = await promise;
    expect(header.type).toBe('INVOKE_RESPONSE');
  });

  it('invoke rejects on timeout and forgets the pending call', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const messenger = createProtocolMessenger(send);
    const promise = messenger.invoke(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        args: {},
      },
      null,
      1000,
    );
    const assertion = expect(promise).rejects.toThrow(/invoke timeout/);
    vi.advanceTimersByTime(1001);
    await assertion;
    const request = send.mock.calls[0]?.[0];
    messenger.handleIncoming(response(request?.requestId));
  });

  it('ignores responses with unknown request ids', () => {
    const send = vi.fn();
    const messenger = createProtocolMessenger(send);
    expect(() =>
      messenger.handleIncoming(response('unknown-id')),
    ).not.toThrow();
  });
});
