import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { MessageProtocol, MessageType } from '../../core/messages';
import type { PluginInvokeResponseHeader } from '../../core/messages';
import { createWebSocketTransport } from '../websocket-client';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  binaryType = '';
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data?: Uint8Array | ArrayBuffer }) => void) | null =
    null;
  sent: ArrayBuffer[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  message(data: Uint8Array | ArrayBuffer): void {
    this.onmessage?.({ data });
  }
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('expected a WebSocket to be created');
  return socket;
}

const protocol = new MessageProtocol();

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
});

describe('createWebSocketTransport', () => {
  it('queues messages while connecting and flushes them on open', () => {
    const transport = createWebSocketTransport('ws://test');
    const socket = lastSocket();

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'q1',
      },
      null,
    );
    expect(socket.sent).toHaveLength(0);

    socket.open();
    expect(socket.sent).toHaveLength(1);
  });

  it('delivers decoded frames to subscribers', () => {
    const transport = createWebSocketTransport('ws://test');
    const socket = lastSocket();
    const headers: unknown[] = [];
    transport.subscribe((message) => headers.push(message.header));

    socket.open();
    socket.message(
      protocol.encode(
        MessageType.ENVELOPE,
        {
          type: 'INVOKE_RESPONSE',
          pluginId: 'core.health',
          event: 'health.ping',
          requestId: 'q1',
          result: { message: 'pong' },
        },
        null,
      ),
    );
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({
      type: 'INVOKE_RESPONSE',
      requestId: 'q1',
    });
  });

  it('fails queued invokes with TRANSPORT_ERROR on close', () => {
    const transport = createWebSocketTransport('ws://test');
    const socket = lastSocket();
    const headers: unknown[] = [];
    transport.subscribe((message) => headers.push(message.header));

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'q2',
      },
      null,
    );
    socket.close();

    expect(headers).toHaveLength(1);
    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.error?.code).toBe('TRANSPORT_ERROR');
  });

  it('emits TRANSPORT_ERROR immediately when the socket is already closed', () => {
    const transport = createWebSocketTransport('ws://test');
    const socket = lastSocket();
    socket.readyState = FakeWebSocket.CLOSED;
    const headers: unknown[] = [];
    transport.subscribe((message) => headers.push(message.header));

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'q3',
      },
      null,
    );

    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.error?.code).toBe('TRANSPORT_ERROR');
  });
});
