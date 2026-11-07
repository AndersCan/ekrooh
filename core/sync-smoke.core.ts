import fs from 'bare-fs';
import path from 'bare-path';
import DHT from 'hyperdht';
import Hyperswarm from 'hyperswarm';
import UDX from 'udx-native';
import { createSyncWith, type Sync, type SwarmPort } from './sync/sync-engine';

/** Global provided by the Bare runtime. */
declare const Bare: { argv?: string[]; exit(code: number): void };

/**
 * Two-peer smoke for `@ekrooh/bare/sync` under `bare`, on a local DHT
 * bootstrapper (no network). Checks: (S1) two devices exchange values,
 * (S2) a device recreated from the same storage keeps its room and peer id
 * and the other side ends with exactly two values, (S3) a bad invite is an
 * error value. Prints `[sync-smoke] ok` and exits 0, or exits 1.
 * Config: `<dir>` (a directory with `a/` and `b/` subdirectories).
 */
type Counts = Record<string, number>;
const parse = (raw: unknown): Counts | undefined =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Counts)
    : undefined;

const CONNECT_BUDGET = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(label: string, ms: number, check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`${label} timed out`);
    await sleep(100);
  }
}

async function reservePort(): Promise<number> {
  const socket = new UDX().createSocket();
  socket.bind(0, '127.0.0.1');
  const port = socket.address().port;
  await socket.close();
  return port;
}

function resolveDir(): string {
  const argv =
    typeof Bare !== 'undefined' && Array.isArray(Bare.argv) ? Bare.argv : [];
  const dir = argv.find((a) => {
    try {
      return fs.statSync(path.join(a, 'a')).isDirectory();
    } catch {
      return false;
    }
  });
  if (dir === undefined) throw new Error('expected <dir> containing a/ and b/');
  return dir;
}

function totalOf(sync: Sync<Counts>): number {
  return sync.values().reduce((sum, v) => sum + (v.value.n ?? 0), 0);
}

async function run() {
  const dir = resolveDir();
  const port = await reservePort();
  const bootstrap = [{ host: '127.0.0.1', port }];
  const bootstrapper = DHT.bootstrapper(port, '127.0.0.1');
  await bootstrapper.ready();
  // A joiner looks the room up once; the room must be announced before it
  // joins, so the smoke flushes the first device explicitly.
  const swarms: Record<string, { flush(): Promise<void> }> = {};
  const make = (name: string, room?: string) => {
    const [error, sync] = createSyncWith<Counts>(
      { storage: path.join(dir, name), parse },
      {
        createSwarm: (seed) => {
          const swarm = new Hyperswarm({ seed, bootstrap, maxPeers: 16 });
          swarms[name] = swarm;
          return swarm as SwarmPort;
        },
      },
    );
    if (error !== null) throw error;
    if (room !== undefined) {
      const [joinError] = sync.join(room);
      if (joinError !== null) throw joinError;
    }
    return sync;
  };

  const a = make('a');
  await swarms.a?.flush();
  let b = make('b', a.invite());
  try {
    // S3
    const [bad] = a.join('not a code');
    if (bad?.code !== 'sync/bad-invite') throw new Error('S3 failed');

    // S1
    a.publish({ n: 1 });
    b.publish({ n: 2 });
    await until(
      'S1 exchange',
      CONNECT_BUDGET,
      () => totalOf(a) === 3 && totalOf(b) === 3,
    );

    // S2
    const room = b.invite();
    const bPeer = b.values().find((v) => v.self)?.peer;
    await b.close();
    b = make('b');
    if (b.invite() !== room) throw new Error('S2 room not kept');
    if (b.values().length !== 0) throw new Error('S2 unexpected values');
    b.publish({ n: 5 });
    if (b.values()[0]?.peer !== bPeer) throw new Error('S2 peer id changed');
    await until('S2 reconnect', CONNECT_BUDGET * 2, () => totalOf(a) === 6);
    if (a.values().length !== 2) {
      throw new Error(`S2 expected 2 values, got ${a.values().length}`);
    }
    console.log('[sync-smoke] ok');
  } finally {
    await a.close();
    await b.close();
    await bootstrapper.destroy().catch(() => undefined);
  }
}

void run()
  .then(() => Bare.exit(0))
  .catch((error) => {
    console.error(
      `[sync-smoke] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    Bare.exit(1);
  });
