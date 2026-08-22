import { describe, expect, it, vi } from 'vite-plus/test';
import { TextDecoder, TextEncoder } from 'node:util';
import {
  attachWebSocketProtocol,
  createLoopbackPush,
} from './websocket-server';
import {
  MessageType,
  MessageProtocol,
  createPluginRegistry,
  createPluginRouter,
  type PluginInvokeResponseHeader,
} from '../messages';
import { createHealthPlugin } from '../../plugins/health/plugin';

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
    socket.emit('data', new Uint8Array([0xff, 0x00, 0x00, 0x00]));
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
