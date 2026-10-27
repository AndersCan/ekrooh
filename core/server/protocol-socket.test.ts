import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { EventEmitter } from 'node:events';
import { MAX_FRAME_BYTES } from '../messages/constants';
import { createProtocolSocketSlot } from './protocol-socket';

const ws = vi.hoisted(() => ({
  handshakeError: null as Error | null,
  sockets: [] as Array<{
    opts: Record<string, unknown>;
    written: Uint8Array[];
    destroyed: boolean;
    emit(event: string, ...args: unknown[]): boolean;
  }>,
}));

vi.mock('bare-ws', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    default: {
      Server: {
        handshake(
          _req: unknown,
          _socket: unknown,
          _head: unknown,
          cb: (err: Error | null) => void,
        ) {
          cb(ws.handshakeError);
        },
      },
      Socket: class extends Emitter {
        written: Uint8Array[] = [];
        destroyed = false;
        constructor(public opts: Record<string, unknown>) {
          super();
          ws.sockets.push(this);
        }
        write(data: Uint8Array) {
          this.written.push(data);
          return true;
        }
        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          this.emit('close');
        }
        pause() {}
        resume() {}
      },
    },
  };
});

function tcpSocket() {
  return Object.assign(new EventEmitter(), {
    setTimeout: vi.fn(),
    destroy: vi.fn(),
  });
}

function slot(replaceMinIntervalMs = 0) {
  return createProtocolSocketSlot({
    idleTimeoutMs: 60_000,
    deadPeerTimeoutMs: 10_000,
    replaceMinIntervalMs,
    maxQueuedBytes: 1024,
  });
}

function accept(s: ReturnType<typeof slot>) {
  const reject = vi.fn();
  const tcp = tcpSocket();
  s.accept(
    { headers: {} } as never,
    tcp as never,
    Buffer.alloc(0) as never,
    reject,
  );
  return { reject, tcp };
}

afterEach(() => {
  ws.sockets.length = 0;
  ws.handshakeError = null;
  vi.restoreAllMocks();
});

describe('createProtocolSocketSlot', () => {
  it('hands an accepted socket to the handlers with bounded options', () => {
    const s = slot();
    const handler = vi.fn();
    s.onConnection(handler);
    const { reject, tcp } = accept(s);
    expect(reject).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ws.sockets[0].opts).toMatchObject({
      isServer: true,
      idleTimeout: 10_000,
      maxPayload: MAX_FRAME_BYTES,
    });
    expect(tcp.setTimeout).toHaveBeenCalledWith(60_000, expect.any(Function));
  });

  it('pushes to the connected socket only', () => {
    const s = slot();
    expect(s.push(new Uint8Array([1]))).toBe(false);
    accept(s);
    expect(s.push(new Uint8Array([2]))).toBe(true);
    expect(ws.sockets[0].written).toEqual([new Uint8Array([2])]);
    ws.sockets[0].emit('close');
    expect(s.push(new Uint8Array([3]))).toBe(false);
  });

  it('replaces the live socket, holding a replacement until the interval passes', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const limited = slot(1_000);
      accept(limited);
      const second = accept(limited);
      expect(second.reject).not.toHaveBeenCalled();
      expect(ws.sockets).toHaveLength(1);

      vi.advanceTimersByTime(1_000);
      expect(ws.sockets).toHaveLength(2);
      expect(ws.sockets[0].destroyed).toBe(true);
      expect(second.reject).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    const open = slot(0);
    accept(open);
    accept(open);
    expect(ws.sockets[2].destroyed).toBe(true);
    expect(ws.sockets[3].destroyed).toBe(false);
    open.push(new Uint8Array([9]));
    expect(ws.sockets[3].written).toEqual([new Uint8Array([9])]);
  });

  it('answers a held upgrade superseded by a newer one with 429', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const limited = slot(1_000);
      accept(limited);
      const held = accept(limited);
      const newest = accept(limited);
      expect(held.reject).toHaveBeenCalledWith(
        'superseded by a newer upgrade',
        429,
      );
      vi.advanceTimersByTime(1_000);
      expect(newest.reject).not.toHaveBeenCalled();
      expect(ws.sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a held upgrade whose peer hangs up, and close() destroys one', () => {
    vi.useFakeTimers();
    try {
      const limited = slot(1_000);
      accept(limited);
      const gone = accept(limited);
      gone.tcp.emit('close');
      vi.advanceTimersByTime(1_000);
      expect(ws.sockets).toHaveLength(1);

      const closing = slot(1_000);
      accept(closing);
      const held = accept(closing);
      closing.close();
      expect(held.tcp.destroy).toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(ws.sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a failed handshake', () => {
    ws.handshakeError = new Error('bad key');
    const { reject } = accept(slot());
    expect(reject).toHaveBeenCalledWith('handshake failed (bad key)');
  });

  it('contains a throwing connection handler', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = slot();
    const after = vi.fn();
    s.onConnection(() => {
      throw new Error('boom');
    });
    s.onConnection(after);
    accept(s);
    expect(after).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('contains a socket error even with no connection handler', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = slot();
    accept(s);
    expect(() =>
      ws.sockets[0].emit('error', new Error('UNEXPECTED_CLOSE')),
    ).not.toThrow();
    expect(ws.sockets[0].destroyed).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      '[loopback] protocol socket error: UNEXPECTED_CLOSE',
    );
    expect(s.push(new Uint8Array([1]))).toBe(false);
  });

  it('close destroys the connected socket', () => {
    const s = slot();
    accept(s);
    s.close();
    expect(ws.sockets[0].destroyed).toBe(true);
  });
});
