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
  it('exchanges an injected bootstrap nonce for a session cookie before opening', async () => {
    vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    createWebSocketTransport('ws://test');

    await nextTick();
    expect(fetchMock).toHaveBeenCalledWith('/login', {
      method: 'POST',
      body: 'one-time-nonce',
    });
    expect(lastSocket().url).toBe('ws://test');
  });

  it('exchanges an injected legacy token for a session cookie before opening', async () => {
    vi.stubGlobal('window', { __ekrooh: { token: 'secret-token' } });
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

  it('never opens a socket when /login is rejected (no token-URL fallback)', async () => {
    vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );

    createWebSocketTransport('ws://test?foo=1');

    await nextTick();
    // A rejected login must NOT fall back to a ?token= URL, and must NOT open
    // any socket — a rejected login has no cookie to ride the upgrade.
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('retries once after a spent-nonce 409 and opens when it succeeds', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 409 })
        .mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      createWebSocketTransport('ws://test');
      await vi.advanceTimersByTimeAsync(500);

      // Exactly one retry after the 409, then the socket opens.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(lastSocket().url).toBe('ws://test');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not open when the spent-nonce retry also fails', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
      const fetchMock = vi.fn(async () => ({ ok: false, status: 409 }));
      vi.stubGlobal('fetch', fetchMock);

      createWebSocketTransport('ws://test');
      await vi.advanceTimersByTimeAsync(500);

      // One retry at most — never a loop against a server that keeps saying 409.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(FakeWebSocket.instances).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not open a socket when /login throws', async () => {
    vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    createWebSocketTransport('ws://test');

    await nextTick();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('fails queued invokes with TRANSPORT_ERROR when /login is rejected', async () => {
    vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );

    const transport = createWebSocketTransport('ws://test');
    await nextTick();

    const headers: unknown[] = [];
    transport.subscribe((message) => headers.push(message.header));
    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'lf1',
      },
      null,
    );

    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.error?.code).toBe('TRANSPORT_ERROR');
    expect(header.error?.message).toContain('session login rejected');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('fails queued invokes with TRANSPORT_ERROR when /login times out', async () => {
    vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );

    const transport = createWebSocketTransport({
      url: 'ws://test',
      loginTimeoutMs: 10,
    });

    const headers: unknown[] = [];
    transport.subscribe((message) => headers.push(message.header));
    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'lt1',
      },
      null,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.error?.code).toBe('TRANSPORT_ERROR');
    expect(header.error?.message).toContain('session login timed out');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('does not call /login when no credential is injected', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    createWebSocketTransport('ws://test');

    await nextTick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips login when explicitly disabled', async () => {
    vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
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
    expect(header.error?.message).toContain(
      'socket never opened after 0 retries',
    );
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

  it('retries on a fresh socket after a rejected upgrade, without a token in the URL', async () => {
    vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );

    const transport = createWebSocketTransport({
      url: 'ws://test',
      maxRetries: 3,
      backoffMs: 5,
    });
    await nextTick();

    const first = lastSocket();
    expect(first.url).toBe('ws://test');
    transport.subscribe(() => {});

    // The mock server rejects the upgrade: the socket closes without ever
    // opening, so the HttpOnly cookie never rode the handshake.
    first.close();

    // The machine backs off and retries on a fresh socket — same clean URL.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(FakeWebSocket.instances.length).toBe(2);
    const second = lastSocket();
    expect(second).not.toBe(first);
    // No ?token= fallback: the retry uses the same clean URL.
    expect(second.url).toBe('ws://test');
    expect(second.url).not.toContain('token');

    // RPC sent during the retry is queued and flushes once the socket opens.
    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'rt1',
      },
      null,
    );
    expect(second.sent).toHaveLength(0);
    second.open();
    expect(second.sent).toHaveLength(1);
  });

  it('gives up after the retry cap when the upgrade is rejected', async () => {
    vi.stubGlobal('window', { __ekrooh: { bootstrap: 'one-time-nonce' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );

    const transport = createWebSocketTransport({
      url: 'ws://test',
      maxRetries: 0,
      backoffMs: 5,
    });
    await nextTick();
    const headers: unknown[] = [];
    transport.subscribe((message) => headers.push(message.header));

    const first = lastSocket();
    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'rt2',
      },
      null,
    );
    first.close(); // rejected → retry cap (0) reached → give up

    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.error?.code).toBe('TRANSPORT_ERROR');
    expect(lastSocket().url).not.toContain('token');
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
