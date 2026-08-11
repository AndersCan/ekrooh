import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
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
  onerror: (() => void) | null = null;
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
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  vi.stubGlobal('window', {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWebSocketTransport URL selection', () => {
  it('defaults to the page same-origin when no URL is given', async () => {
    vi.stubGlobal('window', { location: { host: '127.0.0.1:4321' } });

    createWebSocketTransport();

    await nextTick();
    expect(lastSocket().url).toBe('ws://127.0.0.1:4321');
  });

  it('falls back to localhost:8080 when there is no page origin', async () => {
    createWebSocketTransport();

    await nextTick();
    expect(lastSocket().url).toBe('ws://localhost:8080');
  });

  it('uses an explicit URL verbatim', async () => {
    createWebSocketTransport('ws://example.test/socket');

    await nextTick();
    expect(lastSocket().url).toBe('ws://example.test/socket');
  });
});

describe('createWebSocketTransport /login bootstrap', () => {
  it('exchanges an injected token for a session cookie before opening', async () => {
    vi.stubGlobal('window', { __lessBareToken: 'secret-token' });
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    createWebSocketTransport('ws://test');

    await nextTick();
    expect(fetchMock).toHaveBeenCalledWith('/login', {
      method: 'POST',
      body: 'secret-token',
    });
    expect(lastSocket().url).toBe('ws://test');
  });

  it('falls back to the query token when login is rejected', async () => {
    vi.stubGlobal('window', { __lessBareToken: 'secret-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );

    createWebSocketTransport('ws://test?foo=1');

    await nextTick();
    expect(lastSocket().url).toBe('ws://test/?foo=1&token=secret-token');
  });

  it('falls back to the query token when login throws', async () => {
    vi.stubGlobal('window', { __lessBareToken: 'secret-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    createWebSocketTransport('ws://test');

    await nextTick();
    expect(lastSocket().url).toBe('ws://test/?token=secret-token');
  });

  it('does not call /login when no token is injected', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    createWebSocketTransport('ws://test');

    await nextTick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips login when explicitly disabled', async () => {
    vi.stubGlobal('window', { __lessBareToken: 'secret-token' });
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    createWebSocketTransport({ url: 'ws://test', login: false });

    await nextTick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastSocket().url).toBe('ws://test');
  });
});

describe('createWebSocketTransport messaging', () => {
  it('queues messages while connecting and flushes them on open', async () => {
    const transport = createWebSocketTransport('ws://test');
    await nextTick();
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

  it('delivers decoded frames to subscribers', async () => {
    const transport = createWebSocketTransport('ws://test');
    await nextTick();
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

  it('fails queued invokes with TRANSPORT_ERROR once retries are exhausted', async () => {
    const transport = createWebSocketTransport({
      url: 'ws://test',
      maxRetries: 0,
    });
    await nextTick();
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

    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.error?.code).toBe('TRANSPORT_ERROR');
  });
});

describe('createWebSocketTransport reconnect', () => {
  it('reconnects with backoff after an unexpected close', async () => {
    const transport = createWebSocketTransport({
      url: 'ws://test',
      maxRetries: 3,
      backoffMs: 5,
    });
    await nextTick();
    const first = lastSocket();
    transport.subscribe(() => {});

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(FakeWebSocket.instances.length).toBe(2);
    const second = lastSocket();
    expect(second).not.toBe(first);
    expect(second.url).toBe('ws://test');

    // Messages sent during the backoff are queued and flushed on reopen.
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
    expect(second.sent).toHaveLength(0);
    second.open();
    expect(second.sent).toHaveLength(1);
  });

  it('queues during the reconnect window and errors after the cap', async () => {
    const transport = createWebSocketTransport({
      url: 'ws://test',
      maxRetries: 1,
      backoffMs: 5,
    });
    await nextTick();
    const headers: unknown[] = [];
    transport.subscribe((message) => headers.push(message.header));

    const first = lastSocket();
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = lastSocket();

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'q4',
      },
      null,
    );
    second.close();

    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.error?.code).toBe('TRANSPORT_ERROR');
  });
});
