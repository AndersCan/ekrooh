import { describe, expect, it, vi } from 'vite-plus/test';
import { TextDecoder, TextEncoder } from 'node:util';
import type { HashOptions } from 'node:crypto';
import {
  attachWebSocketProtocol,
  createLoopbackPush,
} from './websocket-server';
import {
  MessageType,
  MessageProtocol,
  createPluginRegistry,
  createPluginRouter,
  type Either,
  type CoreError,
  type PluginInvokeResponseHeader,
  type PluginManifest,
  type PluginRuntimeAdapter,
} from '../messages';
import { createHealthPlugin } from '../../plugins/health/plugin';

// The `../messages` index re-exports `core/logs`, whose routes value-import
// `core/server/static-file-server.ts` → `bare-fs`/`bare-http1`/`bare-ws`/etc.
// Those need a `Bare` host global that plain vitest does not provide; stub them
// with the Node built-ins, mirroring `core/server/static-file-server.test.ts`.
vi.mock('bare-http1', async () => ({
  default: (await import('node:http')).default,
}));
vi.mock('bare-fs', async () => ({
  default: (await import('node:fs')).default,
}));
vi.mock('bare-path', async () => ({
  default: (await import('node:path')).default,
}));
vi.mock('bare-crypto', async () => {
  const crypto = await import('node:crypto');
  return {
    default: {
      ...crypto,
      createHash(algorithm: string, options?: HashOptions) {
        if (algorithm === 'blake2b-256') algorithm = 'sha256';
        return crypto.createHash(algorithm, options);
      },
    },
  };
});
vi.mock('bare-ws', async () => {
  return {
    default: {
      Server: {
        handshake() {
          throw new Error(
            'bare-ws Server.handshake should not be invoked in tests',
          );
        },
      },
      Socket: class {
        constructor() {
          throw new Error('bare-ws Socket should not be instantiated in tests');
        }
      },
    },
  };
});

const protocol = new MessageProtocol({
  encode: (str) => new TextEncoder().encode(str),
  decode: (bytes) => new TextDecoder().decode(bytes),
});

function invokeFrame(header: Record<string, unknown>): Uint8Array {
  return protocol.encode(
    MessageType.ENVELOPE,
    header as Parameters<typeof protocol.encode>[1],
    null,
  );
}

function fakeSocket() {
  const listeners = new Map<string, Array<(data: unknown) => unknown>>();
  return {
    write: vi.fn((_data: unknown) => true),
    destroy: vi.fn(),
    on(event: string, listener: (data: unknown) => unknown) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event: string, data?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(data);
    },
  };
}

function serverHarness() {
  let handler: ((socket: unknown, request: unknown) => void) | null = null;
  const push = vi.fn((_frame: Uint8Array) => true);
  return {
    server: {
      onConnection(h: (socket: unknown, request: unknown) => void) {
        handler = h;
      },
      push,
    },
    get handler() {
      return handler;
    },
  };
}

function healthContext() {
  const registry = createPluginRegistry();
  registry.register(createHealthPlugin());
  const router = createPluginRouter(registry, 'bare');
  return {
    protocol,
    pluginRegistry: registry,
    pluginRouter: router,
  };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** A context whose invoke handler blocks until `release` is called, so a test
 * can interleave new `data` events while an earlier route is still pending —
 * the exact window that used to corrupt a shared receive buffer. */
function deferredContext(events: string[]) {
  const registry = createPluginRegistry();
  let release: (value: [null, unknown]) => void = () => {};
  const pending = new Promise<Either<CoreError, unknown>>((resolve) => {
    release = resolve;
  });
  const adapter: PluginRuntimeAdapter = {
    invoke: () => pending,
  };
  const manifest: PluginManifest = {
    id: 'test.deferred',
    events,
    runtimes: { bare: adapter },
  };
  registry.register(manifest);
  const router = createPluginRouter(registry, 'bare');
  return {
    protocol,
    pluginRegistry: registry,
    pluginRouter: router,
    release,
  };
}

describe('attachWebSocketProtocol', () => {
  it('routes an invoke frame and writes the response envelope', async () => {
    const harness = serverHarness();
    attachWebSocketProtocol(harness.server as never, healthContext() as never);
    const socket = fakeSocket();
    harness.handler!(socket as never, { headers: {} });

    const frame = invokeFrame({
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'r1',
      args: { message: 'hi' },
    });
    socket.emit('data', frame);

    await vi.waitFor(() => expect(socket.write).toHaveBeenCalled());
    const written = socket.write.mock.calls[0][0] as Uint8Array;
    const decoded = protocol.decode(written);
    const header = decoded.header as PluginInvokeResponseHeader;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.event).toBe('health.ping');
    expect(header.requestId).toBe('r1');
    expect(header.result).toEqual({ message: 'hi', ts: expect.any(Number) });
  });

  it('writes an error envelope for unknown events', async () => {
    const harness = serverHarness();
    attachWebSocketProtocol(harness.server as never, healthContext() as never);
    const socket = fakeSocket();
    harness.handler!(socket as never, { headers: {} });

    const frame = invokeFrame({
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.bogus',
      requestId: 'r2',
    });
    socket.emit('data', frame);

    await vi.waitFor(() => expect(socket.write).toHaveBeenCalled());
    const decoded = protocol.decode(
      socket.write.mock.calls[0][0] as Uint8Array,
    );
    expect((decoded.header as PluginInvokeResponseHeader).error?.code).toBe(
      'UNSUPPORTED_EVENT',
    );
  });

  it('ignores empty frames', async () => {
    const harness = serverHarness();
    attachWebSocketProtocol(harness.server as never, healthContext() as never);
    const socket = fakeSocket();
    harness.handler!(socket as never, { headers: {} });

    socket.emit('data', new Uint8Array(0));
    expect(socket.write).not.toHaveBeenCalled();
  });

  it('swallows decode errors instead of crashing the socket', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = serverHarness();
    attachWebSocketProtocol(harness.server as never, healthContext() as never);
    const socket = fakeSocket();
    harness.handler!(socket as never, { headers: {} });

    // A ≥4-byte chunk (one full frame under the header-length framing) with an
    // unsupported version byte — decoded and rejected, not left buffered.
    socket.emit(
      'data',
      new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    );
    expect(socket.write).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reassembles a frame split across data chunks', async () => {
    const harness = serverHarness();
    attachWebSocketProtocol(harness.server as never, healthContext() as never);
    const socket = fakeSocket();
    harness.handler!(socket as never, { headers: {} });

    const frame = invokeFrame({
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'split1',
      args: { message: 'hi' },
    });

    // Deliver the frame one byte at a time; nothing may be decoded until the
    // full frame has arrived.
    for (let i = 0; i < frame.byteLength; i++) {
      socket.emit('data', frame.subarray(i, i + 1));
      expect(socket.write).not.toHaveBeenCalled();
    }

    await vi.waitFor(() => expect(socket.write).toHaveBeenCalledTimes(1));
    const decoded = protocol.decode(
      socket.write.mock.calls[0][0] as Uint8Array,
    );
    expect((decoded.header as PluginInvokeResponseHeader).requestId).toBe(
      'split1',
    );
  });

  it('drains multiple frames from a single coalesced chunk', async () => {
    const harness = serverHarness();
    attachWebSocketProtocol(harness.server as never, healthContext() as never);
    const socket = fakeSocket();
    harness.handler!(socket as never, { headers: {} });

    const frame1 = invokeFrame({
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'coal1',
      args: { message: 'a' },
    });
    const frame2 = invokeFrame({
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'coal2',
      args: { message: 'b' },
    });
    const coalesced = new Uint8Array(frame1.byteLength + frame2.byteLength);
    coalesced.set(frame1, 0);
    coalesced.set(frame2, frame1.byteLength);

    socket.emit('data', coalesced);

    await vi.waitFor(() => expect(socket.write).toHaveBeenCalledTimes(2));
    const ids = socket.write.mock.calls
      .map((c) => c[0] as Uint8Array)
      .map(
        (b) =>
          (protocol.decode(b).header as PluginInvokeResponseHeader).requestId,
      );
    expect(ids).toEqual(['coal1', 'coal2']);
  });

  it('routes a payload-bearing frame reassembled from split chunks (#127)', async () => {
    const harness = serverHarness();
    attachWebSocketProtocol(harness.server as never, healthContext() as never);
    const socket = fakeSocket();
    harness.handler!(socket as never, { headers: {} });

    const payload = new TextEncoder().encode('hello over the wire');
    const frame = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST' as const,
        pluginId: 'core.health',
        event: 'health.payloadEcho',
        requestId: 'payload1',
        args: { label: 'sample' },
      },
      payload,
    );

    // Split the payload-bearing frame mid-payload AND coalesce a second
    // (header-only) frame after it: the framer must recover the declared
    // payload length from the header, frame both correctly, and never treat
    // payload bytes as the next frame's prefix.
    const mid = Math.floor(frame.byteLength / 2);
    const frame2 = invokeFrame({
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'payload2',
      args: {},
    });
    socket.emit('data', frame.subarray(0, mid));
    expect(socket.write).not.toHaveBeenCalled();
    socket.emit('data', concatBytes(frame.subarray(mid), frame2));

    await vi.waitFor(() => expect(socket.write).toHaveBeenCalledTimes(2));
    const decoded = protocol.decode(
      socket.write.mock.calls[0][0] as Uint8Array,
    ) as never as {
      header: PluginInvokeResponseHeader;
    };
    expect(decoded.header.event).toBe('health.payloadEcho');
    expect(decoded.header.requestId).toBe('payload1');
    expect((decoded.header.result as Record<string, unknown>).payloadSize).toBe(
      payload.byteLength,
    );
    // The following frame was not corrupted by leftover payload bytes.
    const second = protocol.decode(socket.write.mock.calls[1][0] as Uint8Array);
    expect((second.header as PluginInvokeResponseHeader).requestId).toBe(
      'payload2',
    );
  });

  it('routes split and coalesced chunks in order without loss', async () => {
    const harness = serverHarness();
    attachWebSocketProtocol(harness.server as never, healthContext() as never);
    const socket = fakeSocket();
    harness.handler!(socket as never, { headers: {} });

    const frame = (requestId: string) =>
      invokeFrame({
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId,
        args: { message: 'x' },
      });
    const f1 = frame('mix1');
    const f2 = frame('mix2');
    const f3 = frame('mix3');
    const f4 = frame('mix4');

    // Chunk one: f1 plus the first byte of f2. Chunk two: the rest of f2, a
    // split-f3 inside the chunk, then f4. Every boundary is arbitrary.
    socket.emit('data', concatBytes(f1, f2.subarray(0, 1)));
    socket.emit(
      'data',
      concatBytes(f2.subarray(1), f3.subarray(0, 4), f3.subarray(4), f4),
    );

    await vi.waitFor(() => expect(socket.write).toHaveBeenCalledTimes(4));
    const ids = socket.write.mock.calls
      .map((c) => c[0] as Uint8Array)
      .map(
        (b) =>
          (protocol.decode(b).header as PluginInvokeResponseHeader).requestId,
      );
    expect(ids).toEqual(['mix1', 'mix2', 'mix3', 'mix4']);
  });

  it('serializes routing across concurrent data events without corrupting buffers (#124)', async () => {
    const ctx = deferredContext(['deferred.ping']);
    const harness = serverHarness();
    attachWebSocketProtocol(harness.server as never, ctx as never);
    const socket = fakeSocket();
    harness.handler!(socket as never, { headers: {} });

    const frame = (requestId: string) =>
      invokeFrame({
        type: 'INVOKE_REQUEST',
        pluginId: 'test.deferred',
        event: 'deferred.ping',
        requestId,
        args: {},
      });

    // The first chunk starts a route that stays pending; the following chunks
    // arrive while it is awaited. A shared mutable buffer would interleave.
    socket.emit('data', frame('d1'));
    socket.emit('data', concatBytes(frame('d2'), frame('d3').subarray(0, 3)));
    socket.emit('data', frame('d3').subarray(3));

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(socket.write).not.toHaveBeenCalled();

    ctx.release([null, { ok: true }]);

    await vi.waitFor(() => expect(socket.write).toHaveBeenCalledTimes(3));
    const ids = socket.write.mock.calls
      .map((c) => c[0] as Uint8Array)
      .map(
        (b) =>
          (protocol.decode(b).header as PluginInvokeResponseHeader).requestId,
      );
    expect(ids).toEqual(['d1', 'd2', 'd3']);
  });
});

describe('createLoopbackPush', () => {
  it('encodes and pushes a dispatch envelope to the connected socket', () => {
    const harness = serverHarness();
    const push = createLoopbackPush(harness.server as never, protocol as never);

    const result = push(
      {
        type: 'DISPATCH',
        pluginId: 'app.photos',
        event: 'photos.changed',
      } as Parameters<typeof push>[0],
      null,
    );

    expect(harness.server.push).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);

    const frame = harness.server.push.mock.calls[0][0] as Uint8Array;
    const decoded = protocol.decode(frame);
    expect(decoded.header).toMatchObject({
      type: 'DISPATCH',
      pluginId: 'app.photos',
      event: 'photos.changed',
    });
  });

  it('reports false when no socket is connected', () => {
    const harness = serverHarness();
    harness.server.push.mockReturnValue(false);
    const push = createLoopbackPush(harness.server as never, protocol as never);

    expect(
      push(
        { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
        null,
      ),
    ).toBe(false);
  });
});
