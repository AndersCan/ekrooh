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

  it('ignores an injected raw token (only the bootstrap nonce logs in)', async () => {
    vi.stubGlobal('window', { __ekrooh: { token: 'secret-token' } });
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    createWebSocketTransport('ws://test');

    await nextTick();
    expect(fetchMock).not.toHaveBeenCalled();
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
    // Default fetch stub answers `{ ok: true }` with no body reader, so the
    // log-tail enrichment fails gracefully and the plain give-up message
    // survives.
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

    // Give-up failure is now async by one log-tail round-trip.
    await vi.waitFor(() => {
      expect(headers).toHaveLength(1);
    });
    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.error?.code).toBe('TRANSPORT_ERROR');
    expect(header.error?.message).toContain(
      'socket never opened after 0 retries',
    );
  });

  it('folds [loopback] rejection lines from the server log tail into the give-up error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          '2026-08-23T00:00:00Z INFO backend boot ok\n' +
          '[loopback] upgrade rejected: origin mismatch (no Origin header)\n' +
          '[loopback] upgrade rejected: unauthorized (no bare_session cookie)',
      })),
    );
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
        requestId: 'q3',
      },
      null,
    );
    socket.close();

    await vi.waitFor(() => {
      expect(headers).toHaveLength(1);
    });
    const header = headers[0] as PluginInvokeResponseHeader;
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://test/logs?tail=50&format=text',
    );
    expect(header.error?.message).toContain('origin mismatch');
    expect(header.error?.message).toContain('unauthorized');
  });

  it('names the auth path when the log tail route itself is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401 })),
    );
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
        requestId: 'q4',
      },
      null,
    );
    socket.close();

    await vi.waitFor(() => {
      expect(headers).toHaveLength(1);
    });
    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.error?.message).toContain(
      'server log tail unavailable (HTTP 401)',
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

    // Give-up failure is now async by one log-tail round-trip.
    await vi.waitFor(() => {
      expect(headers).toHaveLength(1);
    });
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

    // Give-up failure is now async by one log-tail round-trip.
    await vi.waitFor(() => {
      expect(headers).toHaveLength(1);
    });
    const header = headers[0] as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.error?.code).toBe('TRANSPORT_ERROR');
  });
});

describe('createWebSocketTransport after a successful connect', () => {
  const invoke = (requestId: string) =>
    [
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId,
      },
      null,
    ] as const;

  /** Connects once, then fails `failures` reconnects in a row. */
  async function connectThenFail(failures: number, maxRetries = 2) {
    const transport = createWebSocketTransport({
      url: 'ws://test',
      maxRetries,
      backoffMs: 5,
    });
    await vi.advanceTimersByTimeAsync(0);
    lastSocket().open();
    lastSocket().close();
    for (let i = 0; i < failures; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      lastSocket().close();
    }
    return transport;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps reconnecting past maxRetries consecutive failures', async () => {
    await connectThenFail(8);
    const before = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances.length).toBe(before + 1);

    lastSocket().open();
    expect(lastSocket().readyState).toBe(FakeWebSocket.OPEN);
  });

  it('fails invokes fast during a long outage and works again once reconnected', async () => {
    const transport = await connectThenFail(5);
    const headers: PluginInvokeResponseHeader[] = [];
    transport.subscribe((m) => headers.push(m.header as never));

    transport.send(...invoke('offline'));
    expect(headers).toHaveLength(1);
    expect(headers[0].requestId).toBe('offline');
    expect(headers[0].error?.code).toBe('TRANSPORT_ERROR');

    await vi.advanceTimersByTimeAsync(2000);
    lastSocket().open();
    transport.send(...invoke('online'));
    expect(lastSocket().sent).toHaveLength(1);
    expect(headers).toHaveLength(1);
  });

  it('fails requests queued before the outage turned long', async () => {
    const transport = createWebSocketTransport({
      url: 'ws://test',
      maxRetries: 1,
      backoffMs: 5,
    });
    await vi.advanceTimersByTimeAsync(0);
    lastSocket().open();
    const headers: PluginInvokeResponseHeader[] = [];
    transport.subscribe((m) => headers.push(m.header as never));
    lastSocket().close();
    transport.send(...invoke('queued'));
    expect(headers).toHaveLength(0);

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      lastSocket().close();
    }
    expect(headers.map((h) => h.requestId)).toEqual(['queued']);
    expect(headers[0].error?.code).toBe('TRANSPORT_ERROR');
  });

  describe('returning to the foreground', () => {
    let handlers: Record<string, () => void>;
    let doc: { visibilityState: string; addEventListener: unknown };
    beforeEach(() => {
      handlers = {};
      doc = {
        visibilityState: 'visible',
        addEventListener: vi.fn((type: string, fn: () => void) => {
          handlers[type] = fn;
        }),
      };
      vi.stubGlobal('document', doc);
    });

    it('retries immediately instead of waiting out the backoff', async () => {
      await connectThenFail(5);
      const before = FakeWebSocket.instances.length;
      handlers['visibilitychange']();
      expect(FakeWebSocket.instances.length).toBe(before + 1);
      // The pending backoff timer must not open a second socket.
      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeWebSocket.instances.length).toBe(before + 1);
    });

    it('ignores a visibilitychange to hidden', async () => {
      await connectThenFail(2);
      const before = FakeWebSocket.instances.length;
      doc.visibilityState = 'hidden';
      handlers['visibilitychange']();
      expect(FakeWebSocket.instances.length).toBe(before);
    });

    it('treats a socket the browser already closed as lost', async () => {
      createWebSocketTransport({ url: 'ws://test', backoffMs: 5 });
      await vi.advanceTimersByTimeAsync(0);
      const stale = lastSocket();
      stale.open();
      // Suspended page: readyState moved on but `onclose` has not fired yet.
      stale.readyState = FakeWebSocket.CLOSED;
      handlers['visibilitychange']();
      await vi.advanceTimersByTimeAsync(2000);
      expect(lastSocket()).not.toBe(stale);
    });

    it('ignores a late close from a socket that was already replaced', async () => {
      createWebSocketTransport({ url: 'ws://test', backoffMs: 5 });
      await vi.advanceTimersByTimeAsync(0);
      const stale = lastSocket();
      stale.open();
      stale.readyState = FakeWebSocket.CLOSED;
      handlers['visibilitychange']();
      await vi.advanceTimersByTimeAsync(2000);
      const fresh = lastSocket();
      const count = FakeWebSocket.instances.length;
      stale.onclose?.();
      await vi.advanceTimersByTimeAsync(2000);
      expect(FakeWebSocket.instances.length).toBe(count);
      fresh.open();
      expect(fresh.readyState).toBe(FakeWebSocket.OPEN);
    });
  });
});
