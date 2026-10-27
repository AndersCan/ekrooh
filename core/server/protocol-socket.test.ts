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

  it('replaces the live socket, but not faster than the minimum interval', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const limited = slot(60_000);
    accept(limited);
    const second = accept(limited);
    expect(second.reject).toHaveBeenCalledWith(
      expect.stringContaining('replacement rate limit'),
    );
    expect(ws.sockets).toHaveLength(1);

    const open = slot(0);
    accept(open);
    accept(open);
    expect(ws.sockets[1].destroyed).toBe(true);
    expect(ws.sockets[2].destroyed).toBe(false);
    open.push(new Uint8Array([9]));
    expect(ws.sockets[2].written).toEqual([new Uint8Array([9])]);
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
