import { describe, expect, it } from 'vite-plus/test';
import { createMockTransport } from './mock';
import { MessageType } from '../../core/messages';
import type { WireMessage } from '../../core/messages';

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createMockTransport', () => {
  it('responds to a known event with a result', async () => {
    const transport = createMockTransport();
    const messages: WireMessage[] = [];
    transport.subscribe((message) => messages.push(message));

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'req-1',
        args: { message: 'hi' },
      },
      null,
    );
    await flush();

    expect(messages).toHaveLength(1);
    const header = messages[0]?.header;
    expect(header?.type).toBe('INVOKE_RESPONSE');
    expect(header?.requestId).toBe('req-1');
    if (header?.type === 'INVOKE_RESPONSE') {
      expect(header.result).toEqual({
        message: 'hi',
        ts: expect.any(Number),
      });
    }
  });

  it('responds to logs.view and logs.clear invoke requests', async () => {
    const transport = createMockTransport();
    const messages: WireMessage[] = [];
    transport.subscribe((message) => messages.push(message));

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.logs',
        event: 'logs.view',
        requestId: 'req-logs-1',
        args: { tail: 10 },
      },
      null,
    );
    await flush();
    const viewHeader = messages[0]?.header;
    expect(viewHeader?.type).toBe('INVOKE_RESPONSE');
    if (viewHeader?.type === 'INVOKE_RESPONSE') {
      expect(viewHeader.result).toEqual({ entries: [] });
    }

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.logs',
        event: 'logs.clear',
        requestId: 'req-logs-2',
      },
      null,
    );
    await flush();
    const clearHeader = messages[1]?.header;
    if (clearHeader?.type === 'INVOKE_RESPONSE') {
      expect(clearHeader.result).toEqual({ cleared: 0 });
    }
  });

  it('reports UNSUPPORTED_EVENT for unknown events', async () => {
    const transport = createMockTransport();
    const messages: WireMessage[] = [];
    transport.subscribe((message) => messages.push(message));

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.mystery',
        event: 'mystery.run',
        requestId: 'req-2',
      },
      null,
    );
    await flush();

    const header = messages[0]?.header;
    expect(header?.type).toBe('INVOKE_RESPONSE');
    if (header?.type === 'INVOKE_RESPONSE') {
      expect(header.error?.code).toBe('UNSUPPORTED_EVENT');
    }
  });

  it('ignores non-INVOKE_REQUEST messages', async () => {
    const transport = createMockTransport();
    const messages: WireMessage[] = [];
    transport.subscribe((message) => messages.push(message));

    transport.send(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      null,
    );
    await flush();
    expect(messages).toHaveLength(0);
  });

  it('stops delivering after unsubscribe', async () => {
    const transport = createMockTransport();
    const messages: WireMessage[] = [];
    const unsubscribe = transport.subscribe((message) =>
      messages.push(message),
    );

    unsubscribe();
    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'req-3',
      },
      null,
    );
    await flush();
    expect(messages).toHaveLength(0);
  });
});
