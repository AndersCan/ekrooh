import Corestore from 'corestore';
import Hyperdrive from 'hyperdrive';
import Hyperswarm from 'hyperswarm';
import DHT from 'hyperdht';
import UDX from 'udx-native';
import fs from 'bare-fs';
import path from 'bare-path';

/** Global provided by the Bare runtime. */
declare const Bare: { argv?: string[]; exit(code: number): void };

/**
 * Dev verification worklet (tickets #24, #28, #41): proves the p2p native
 * addons (rocksdb-native via corestore, sodium-native via hyperdrive/
 * hyperswarm, udx-native via the DHT and peer connections) actually run on a
 * target runtime, that a real hyperswarm connection works end-to-end, AND
 * that a peer's drive can be opened by key and read over that connection —
 * the exact flow the on-device photo app times out on (issue #41, "timeout
 * opening remote drive"). Booted under `bare` (macOS smoke), inside the iOS
 * reference app (simulator), or by the Android reference app's instrumentation
 * test (emulator):
 * 1. opens a Corestore, writes/reads through a Hyperdrive,
 * 2. brings up a local `HyperDHT.bootstrapper` on an ephemeral loopback port,
 *    joins two in-process Hyperswarms on one topic, completes a real Noise
 *    secret-stream handshake, and round-trips a message through it (echo
 *    asserted),
 * 3. replicates a drive across two real peers: a creator announces its drive's
 *    discoveryKey and serves it; a reader joins the topic client-only, opens
 *    the drive by key, `ready()`s it (the #41 call), and reads a photo.
 * Writes `<storage>/p2p-verify.ok` (or `<storage>/p2p-verify.fail`) and
 * exits. Dev tooling — not public surface.
 *
 * The local bootstrapper deliberately uses an ephemeral port so a stale
 * bootstrapper from a previous (possibly killed) smoke can never shadow this
 * run: stale announce records in a long-lived local DHT make fresh peers
 * waste their connection budget on dead sockets (ETIMEDOUT/ECONNRESET) and
 * never reach each other — exactly the "p2p blocked on macOS" symptoms
 * reported in issue #28. A fresh ephemeral bootstrapper makes the smoke
 * deterministic.
 *
 * Config: `<storageDir>` (a fresh dir; corestore lands under it).
 */
function resolveStorageDir(): string {
  const argv =
    typeof Bare !== 'undefined' && Array.isArray(Bare.argv) ? Bare.argv : [];
  const isDirectory = (p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      try {
        console.debug(
          `[p2p-verify] statSync(${p}) failed; treating as not a directory`,
        );
      } catch {
        // Observability only — never throw.
      }
      return false;
    }
  };
  const dir = argv.find((a) => isDirectory(a));
  if (typeof dir === 'string') return dir;
  throw new Error(
    'p2p-verify config expected: <storageDir> (e.g. bare p2p-verify.core.gen.js /tmp/p2p-verify)',
  );
}

const storageDir = resolveStorageDir();
const okMarker = path.join(storageDir, 'p2p-verify.ok');
const failMarker = path.join(storageDir, 'p2p-verify.fail');

// Optional `mode=self` argv token: runs only the self-contained corestore/
// hyperdrive smoke (native addons load + self-reads). Used by the Android
// emulator instrumentation test — real DHT peer discovery (server:true
// sockets reachable from a peer) is unreliable under a software-rendered
// x86_64 CI emulator, so the on-device Android gate asserts the addon stack
// boots and reads locally; the full peer-drive replication gate runs on the
// macOS smoke and the iOS simulator, where the DHT reliably works. Matches
// the issue #41 observation that the "reverse direction" (device serving its
// own drive) always worked on Android.
function resolveMode(): 'full' | 'self' {
  const argv =
    typeof Bare !== 'undefined' && Array.isArray(Bare.argv) ? Bare.argv : [];
  return argv.includes('mode=self') ? 'self' : 'full';
}
const verifyMode = resolveMode();

const P2P_TOPIC = Buffer.alloc(32, 7);
/** On-device DHT + Noise handshake budget: the in-process DHT runs 5-10x
 * slower under a software-rendered CI emulator (x86_64 + swiftshader) than on
 * a desktop; a 30s budget made the handshake flaky there (issue #41 PR). */
const HANDSHAKE_TIMEOUT = 60_000;
/** Matches the on-device photo app's remote-open deadline (issue #41); a
 * local-loopback DHT usually resolves far sooner, the headroom is for slow
 * CI emulators/simulators. */
const REMOTE_DRIVE_TIMEOUT = 45_000;

/** Minimal structural type for the swarm connection streams (the p2p
 * packages ship no TS declarations; this worklet is dev tooling). */
interface SmokeStream {
  write(data: string): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'data', cb: (data: Buffer) => void): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Grab a free loopback UDP port so the local bootstrapper can never
 * collide with (or be shadowed by) a stale one from a previous run. */
async function reserveLoopbackPort(): Promise<number> {
  const socket = new UDX().createSocket();
  socket.bind(0, '127.0.0.1');
  const port = socket.address().port;
  await socket.close();
  return port;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Real connect + Noise handshake smoke (issue #28): local bootstrapper,
 * two in-process swarms on one topic, message round-trip over the encrypted
 * stream. Resolves with the round-trip latency on success. */
async function verifyP2PHandshake(bootstrapPort: number): Promise<number> {
  const bootstrap = [{ host: '127.0.0.1', port: bootstrapPort }];
  const bootstrapper = DHT.bootstrapper(bootstrapPort, '127.0.0.1');

  const server = new Hyperswarm({ bootstrap });
  const client = new Hyperswarm({ bootstrap });

  const nonce = `${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9)}`;
  const probe = `bare-p2p-hello:${nonce}`;
  const expectedEcho = `bare-p2p-echo:${nonce}`;

  const errors: string[] = [];
  let echoReceived = '';

  const push = (err: unknown) => {
    if (err instanceof Error) errors.push(err.message);
  };

  server.on('error', push);
  client.on('error', push);

  server.on('connection', (conn: SmokeStream) => {
    conn.on('error', push);
    conn.on('data', (data) => {
      const message = data.toString();
      if (message.startsWith('bare-p2p-hello:')) {
        conn.write(`bare-p2p-echo:${message.slice('bare-p2p-hello:'.length)}`);
      }
    });
  });

  client.on('connection', (conn: SmokeStream) => {
    conn.on('error', push);
    conn.on('data', (data) => {
      if (data.toString() === expectedEcho) echoReceived = expectedEcho;
    });
    conn.write(probe);
  });

  try {
    const start = Date.now();

    // Sequential joins: the client's first lookup must land after the
    // server's announce is stored, or `flushed()` resolves from a lookup
    // that raced ahead of the announce (no peer, next refresh ~5 min out).
    const serverJoin = server.join(P2P_TOPIC, { server: true, client: true });
    await withTimeout(
      serverJoin.flushed(),
      HANDSHAKE_TIMEOUT,
      'server discovery',
    );

    let clientJoin = client.join(P2P_TOPIC, { server: true, client: true });
    await withTimeout(
      clientJoin.flushed(),
      HANDSHAKE_TIMEOUT,
      'client discovery',
    );

    // Require a REAL cross-peer connection before calling it done: a client
    // lookup racing the server's announce can resolve from the client's own
    // announce and dial itself — the client shows a peer but the server stays
    // 0/0 and no echo ever arrives ("no p2p handshake/echo ... 0/0 server
    // peers/conns, 1/1 client peers/conns" on a slow CI emulator). Re-join
    // (fresh lookup) until the SERVER reports a peer, then wait for the echo.
    while (Date.now() - start < HANDSHAKE_TIMEOUT && !echoReceived) {
      if (server.peers.size === 0) {
        try {
          clientJoin.destroy();
        } catch {
          try {
            console.debug(
              `[p2p-verify] clientJoin.destroy() threw; join already destroyed`,
            );
          } catch {
            // Observability only — never throw.
          }
        }
        clientJoin = client.join(P2P_TOPIC, { server: true, client: true });
        await clientJoin.flushed().catch(() => undefined);
      }
      await sleep(1500);
    }

    if (!echoReceived) {
      const conns =
        `${server.peers.size}/${server.connections.size} server peers/conns, ` +
        `${client.peers.size}/${client.connections.size} client peers/conns`;
      const detail = errors.length
        ? `; errors: ${errors.slice(0, 3).join('; ')}`
        : '';
      throw new Error(
        `no p2p handshake/echo within ${HANDSHAKE_TIMEOUT}ms (${conns}${detail})`,
      );
    }

    return Date.now() - start;
  } finally {
    await server.destroy().catch(() => undefined);
    await client.destroy().catch(() => undefined);
    await bootstrapper.destroy().catch(() => undefined);
  }
}

/** Minimal structural type for the p2p stack (no TS declarations shipped):
 * a Corestore-backed store, a Hyperdrive, and a Hyperswarm. Dev tooling. */
interface SmokeStore {
  replicate(conn: unknown): unknown;
  ready(): Promise<void>;
  close(): Promise<void>;
}
interface SmokeDrive {
  key: Buffer;
  discoveryKey: Buffer;
  ready(): Promise<void>;
  put(path: string, data: Buffer): Promise<void>;
  get(path: string): Promise<Uint8Array | null | undefined>;
}
interface SmokeSwarm {
  on(event: 'connection', cb: (conn: SmokeStream) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  join(
    topic: Buffer,
    opts: { server: boolean; client: boolean },
  ): { flushed(): Promise<void>; destroy(): void | Promise<void> };
  connections: { size: number };
  destroy(): Promise<void>;
}

/**
 * Peer-drive replication smoke (issue #41): the exact on-device flow that
 * times out on the Android bare-kit runtime — open a PEER's drive by key,
 * `drive.ready()` it, and read a photo. Two in-process Corestores + swarms
 * over the local bootstrapper: the creator announces its drive's
 * discoveryKey (`server: true`) and serves it; the reader joins the topic
 * client-only (`server: false`, the photo app's reader posture), opens the
 * drive by key, `ready()`s (the failing call), and reads a sparse range.
 * RocksDB storage, udx sockets, and sodium block hashing all run for real on
 * the target runtime, so a green here on a runtime proves the platform can
 * do peer reads; a red reproduces issue #41. Resolves with the elapsed ms.
 */
async function verifyPeerDriveReplication(
  bootstrapPort: number,
): Promise<number> {
  const bootstrap = [{ host: '127.0.0.1', port: bootstrapPort }];
  const bootstrapper = DHT.bootstrapper(bootstrapPort, '127.0.0.1');

  const creatorStore: SmokeStore = new Corestore(
    path.join(storageDir, 'peer-drive-creator'),
  );
  const readerStore: SmokeStore = new Corestore(
    path.join(storageDir, 'peer-drive-reader'),
  );
  const creatorSwarm: SmokeSwarm = new Hyperswarm({ bootstrap });
  const readerSwarm: SmokeSwarm = new Hyperswarm({ bootstrap });

  const errors: string[] = [];
  const push = (err: unknown) => {
    if (err instanceof Error) errors.push(err.message);
  };

  // Replicate every core over every connection — mirrors the photo app's
  // `swarm.on('connection', conn => corestore.replicate(conn))` wiring.
  const wire = (swarm: SmokeSwarm, store: SmokeStore) => {
    swarm.on('error', push);
    swarm.on('connection', (conn) => {
      conn.on('error', push);
      try {
        store.replicate(conn);
      } catch (err) {
        push(err);
      }
    });
  };
  wire(creatorSwarm, creatorStore);
  wire(readerSwarm, readerStore);

  try {
    const start = Date.now();

    const creatorDrive: SmokeDrive = new Hyperdrive(creatorStore);
    await withTimeout(
      creatorDrive.ready(),
      HANDSHAKE_TIMEOUT,
      'creator drive ready',
    );
    const photo = Buffer.from(`peer-drive-photo:${Date.now().toString(16)}`);
    await withTimeout(
      creatorDrive.put('/photos/remote.jpg', photo),
      HANDSHAKE_TIMEOUT,
      'creator drive put',
    );
    const topic = creatorDrive.discoveryKey;

    const creatorJoin = creatorSwarm.join(topic, {
      server: true,
      client: true,
    });
    await withTimeout(
      creatorJoin.flushed(),
      HANDSHAKE_TIMEOUT,
      'creator discovery',
    );

    // Reader opens the drive by key before the swarm joins — the same order
    // the photo app uses (new Hyperdrive(corestore, key) → join → ready).
    const readerDrive: SmokeDrive = new Hyperdrive(
      readerStore,
      creatorDrive.key,
    );
    await withTimeout(
      readerStore.ready(),
      HANDSHAKE_TIMEOUT,
      'reader corestore ready',
    );
    const readerJoin = readerSwarm.join(topic, { server: false, client: true });
    await withTimeout(
      readerJoin.flushed(),
      HANDSHAKE_TIMEOUT,
      'reader discovery',
    );

    // Wait for the real peer connection before ready(): the app's ready()
    // race needs the replication stream up (a few seconds on a fresh DHT;
    // slower on a CI emulator).
    const connectedAt = Date.now();
    while (
      Date.now() - connectedAt < REMOTE_DRIVE_TIMEOUT &&
      readerSwarm.connections.size === 0
    ) {
      await sleep(250);
    }
    if (readerSwarm.connections.size === 0) {
      const detail = errors.length
        ? `; errors: ${errors.slice(0, 3).join('; ')}`
        : '';
      throw new Error(
        `no peer connection for the reader within ${REMOTE_DRIVE_TIMEOUT}ms${detail}`,
      );
    }

    // THE issue #41 call: a remote drive.ready() over a real p2p connection.
    await withTimeout(
      readerDrive.ready(),
      REMOTE_DRIVE_TIMEOUT,
      'remote drive ready',
    );

    const got = await withTimeout(
      readerDrive.get('/photos/remote.jpg'),
      REMOTE_DRIVE_TIMEOUT,
      'remote drive get',
    );
    const readback = got ? Buffer.from(got as Uint8Array) : null;
    if (!readback || !photo.equals(readback)) {
      throw new Error(
        `peer-drive readback mismatch: ${readback?.toString() ?? 'null'}`,
      );
    }

    return Date.now() - start;
  } finally {
    await creatorSwarm.destroy().catch(() => undefined);
    await readerSwarm.destroy().catch(() => undefined);
    await bootstrapper.destroy().catch(() => undefined);
    await creatorStore.close().catch(() => undefined);
    await readerStore.close().catch(() => undefined);
  }
}

async function run() {
  const corestore = new Corestore(path.join(storageDir, 'corestore'));
  await corestore.ready();

  const drive = new Hyperdrive(corestore);
  await drive.put('/verify.txt', Buffer.from('p2p verify ok'));
  const data = await drive.get('/verify.txt');
  if (data?.toString() !== 'p2p verify ok') {
    throw new Error(`hyperdrive readback mismatch: ${data?.toString()}`);
  }

  // In `self` mode (Android CI emulator) stop here: peer discovery is not
  // reliable under the hosted x86_64 emulator. The full peer-drive gate runs
  // on the macOS smoke and the iOS simulator.
  let marker = `ok ${drive.key?.toString('hex') ?? ''} self-read`;
  if (verifyMode === 'full') {
    const roundtripMs = await verifyP2PHandshake(await reserveLoopbackPort());
    const peerDriveMs = await verifyPeerDriveReplication(
      await reserveLoopbackPort(),
    );
    marker = `ok ${drive.key?.toString('hex') ?? ''} p2p-handshake ${roundtripMs}ms peer-drive ${peerDriveMs}ms`;
  }

  fs.writeFileSync(okMarker, marker);
}

void run()
  .then(() => Bare.exit(0))
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    try {
      fs.writeFileSync(failMarker, message);
    } catch {
      try {
        console.debug(
          `[p2p-verify] failed to write fail marker ${failMarker}; exit code still signals failure`,
        );
      } catch {
        // Observability only — never throw.
      }
    }
    Bare.exit(1);
  });
