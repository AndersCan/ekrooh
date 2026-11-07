import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import {
  createSyncWith,
  type ConnPort,
  type Sync,
  type SwarmPort,
} from './sync-engine';
import { topicForInvite } from './invite';

type Handler = (...args: never[]) => void;

class FakeConn implements ConnPort {
  written: string[] = [];
  destroyed = false;
  handlers = new Map<string, Handler[]>();
  constructor(public remotePublicKey: Uint8Array) {}
  write(data: string) {
    this.written.push(data);
  }
  on(event: string, cb: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emit(event: string, ...args: unknown[]) {
    for (const cb of this.handlers.get(event) ?? []) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }
  destroy() {
    this.destroyed = true;
  }
  receive(text: string) {
    this.emit('data', Buffer.from(text));
  }
}

class FakeSwarm implements SwarmPort {
  keyPair = { publicKey: Buffer.alloc(32, 1) };
  joined: Buffer[] = [];
  left: Buffer[] = [];
  destroyedCount = 0;
  connectionCb: ((c: ConnPort) => void) | undefined;
  on(event: string, cb: (...a: never[]) => void) {
    if (event === 'connection') this.connectionCb = cb as never;
  }
  join(topic: Buffer) {
    this.joined.push(topic);
  }
  leave(topic: Buffer) {
    this.left.push(topic);
  }
  destroy() {
    this.destroyedCount++;
  }
  connect(id: number) {
    const conn = new FakeConn(Buffer.alloc(32, id));
    this.connectionCb?.(conn);
    return conn;
  }
}

type Counts = Record<string, number>;
const parse = (raw: unknown): Counts | undefined =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Counts)
    : undefined;
const line = (value: unknown, v = 1) => `${JSON.stringify({ v, value })}\n`;

let swarm: FakeSwarm;
let sync: Sync<Counts>;
let logs: string[];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(m));
  vi.spyOn(console, 'warn').mockImplementation(
    (m: string) => void logs.push(m),
  );
  swarm = new FakeSwarm();
  const [error, made] = createSyncWith<Counts>(
    { parse },
    { createSwarm: () => swarm },
  );
  expect(error).toBeNull();
  sync = made!;
});
afterEach(() => vi.restoreAllMocks());

const peerId = (id: number) => Buffer.alloc(32, id).toString('hex');

describe('sync engine', () => {
  it('joins the room topic on start', () => {
    expect(swarm.joined).toHaveLength(1);
    expect(swarm.joined[0]!.equals(topicForInvite(sync.invite()))).toBe(true);
  });

  it('sends the self value first on connect', () => {
    sync.publish({ tea: 1 });
    const conn = swarm.connect(2);
    expect(conn.written).toEqual([line({ tea: 1 })]);
  });

  it('sends nothing on connect before a value is published', () => {
    expect(swarm.connect(2).written).toEqual([]);
  });

  it('publish writes to every open connection', () => {
    const a = swarm.connect(2);
    const b = swarm.connect(3);
    sync.publish({ tea: 2 });
    expect(a.written).toEqual([line({ tea: 2 })]);
    expect(b.written).toEqual([line({ tea: 2 })]);
  });

  it('lists self first, then peers by id', () => {
    sync.publish({ me: 1 });
    swarm.connect(9).receive(line({ n: 9 }));
    swarm.connect(3).receive(line({ n: 3 }));
    const values = sync.values();
    expect(values.map((v) => v.self)).toEqual([true, false, false]);
    expect(values.map((v) => v.peer)).toEqual([
      peerId(1),
      peerId(3),
      peerId(9),
    ]);
  });

  it('fires onChange once for the same line twice', () => {
    const listener = vi.fn();
    sync.onChange(listener);
    const conn = swarm.connect(2);
    listener.mockClear();
    conn.receive(line({ a: 1 }));
    conn.receive(line({ a: 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
    conn.receive(line({ a: 2 }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reads a line split across chunks', () => {
    const conn = swarm.connect(2);
    const text = line({ a: 1 });
    conn.receive(text.slice(0, 5));
    conn.receive(text.slice(5));
    expect(sync.values()[0]?.value).toEqual({ a: 1 });
  });

  it('ignores wrong version, bad JSON and rejected values, one log each', () => {
    const conn = swarm.connect(2);
    conn.receive(line({ a: 1 }, 2));
    conn.receive(line({ a: 1 }, 3));
    conn.receive('not json\nalso not\n');
    conn.receive(line(5));
    conn.receive(line('x'));
    expect(sync.values()).toEqual([]);
    expect(logs.filter((l) => l.includes('uses sync v2'))).toHaveLength(1);
    expect(logs.filter((l) => l.includes('bad message'))).toHaveLength(1);
    expect(
      logs.filter((l) => l.includes('value this app does not accept')),
    ).toHaveLength(1);
  });

  it('drops a value when parse throws', () => {
    const swarm2 = new FakeSwarm();
    const [, s2] = createSyncWith<Counts>(
      {
        parse: () => {
          throw new Error('boom');
        },
      },
      { createSwarm: () => swarm2 },
    );
    swarm2.connect(2).receive(line({ a: 1 }));
    expect(s2!.values()).toEqual([]);
  });

  it('disconnects a peer that sends an oversized line', () => {
    const conn = swarm.connect(2);
    conn.receive('a'.repeat(33 * 1024));
    expect(conn.destroyed).toBe(true);
    expect(
      logs.some((l) => l.includes('oversized message; disconnected')),
    ).toBe(true);
  });

  it('keeps a disconnected peer value and lowers connected()', () => {
    const conn = swarm.connect(2);
    conn.receive(line({ a: 1 }));
    expect(sync.connected()).toBe(1);
    conn.emit('close');
    expect(sync.connected()).toBe(0);
    expect(sync.values()).toHaveLength(1);
  });

  it('keeps a peer connected when a newer connection opens before the old one closes', () => {
    const old = swarm.connect(2);
    old.receive(line({ a: 1 }));
    const fresh = swarm.connect(2);
    expect(sync.connected()).toBe(1);
    old.emit('close');
    expect(sync.connected()).toBe(1);
    fresh.emit('close');
    expect(sync.connected()).toBe(0);
  });

  it('destroys a connection from itself', () => {
    const conn = swarm.connect(1);
    expect(conn.destroyed).toBe(true);
    expect(sync.connected()).toBe(0);
  });

  it('join clears peers, leaves the old topic and joins the new one', () => {
    const listener = vi.fn();
    const oldCode = sync.invite();
    const conn = swarm.connect(2);
    conn.receive(line({ a: 1 }));
    sync.onChange(listener);
    const code = 'ab'.repeat(16);
    expect(sync.join(`  ${code.toUpperCase()} `)).toEqual([null, true]);
    expect(sync.invite()).toBe(code);
    expect(sync.values()).toEqual([]);
    expect(sync.connected()).toBe(0);
    expect(conn.destroyed).toBe(true);
    expect(swarm.left[0]!.equals(topicForInvite(oldCode))).toBe(true);
    expect(swarm.joined[1]!.equals(topicForInvite(code))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    conn.emit('close');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('join of the current code is a no-op', () => {
    const listener = vi.fn();
    sync.onChange(listener);
    expect(sync.join(sync.invite())).toEqual([null, true]);
    expect(swarm.joined).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('join rejects a bad code', () => {
    expect(sync.join('nope')[0]?.code).toBe('sync/bad-invite');
  });

  it('publish rejects non-JSON values', () => {
    expect(sync.publish(5n as never)[0]?.code).toBe('sync/not-json');
  });

  it('calls after close return sync/closed and values stay', async () => {
    sync.publish({ a: 1 });
    await sync.close();
    await sync.close();
    expect(swarm.destroyedCount).toBe(1);
    expect(sync.join('ab'.repeat(16))[0]?.code).toBe('sync/closed');
    expect(sync.publish({ a: 2 })[0]?.code).toBe('sync/closed');
    expect(sync.values()).toHaveLength(1);
  });

  it('logs a throwing listener and keeps notifying the rest', () => {
    const good = vi.fn();
    sync.onChange(() => {
      throw new Error('bad listener');
    });
    sync.onChange(good);
    swarm.connect(2);
    expect(
      logs.some((l) => l.includes('onChange listener failed: bad listener')),
    ).toBe(true);
    expect(good).toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const off = sync.onChange(listener);
    off();
    swarm.connect(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it('logs only a short room prefix and peer id', () => {
    swarm.connect(2);
    expect(logs.some((l) => l.includes(sync.invite()))).toBe(false);
    expect(
      logs.some((l) =>
        l.includes(`peer ${peerId(2).slice(0, 8)} connected (1 connected)`),
      ),
    ).toBe(true);
  });
});
