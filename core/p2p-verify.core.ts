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
 * Dev verification worklet (ticket #24, #28): proves the p2p native addons
 * (rocksdb-native via corestore, sodium-native via hyperdrive/hyperswarm,
 * udx-native via the DHT and peer connections) actually run on a target
 * runtime AND that a real hyperswarm connection works end-to-end. Booted
 * under `bare` (macOS smoke) or inside the iOS reference app (simulator):
 * opens a Corestore, writes/reads through a Hyperdrive, then brings up a
 * local `HyperDHT.bootstrapper` on an ephemeral loopback port, joins two
 * in-process Hyperswarms on one topic, completes a real Noise secret-stream
 * handshake, and round-trips a message through it (echo asserted). Writes
 * `<storage>/p2p-verify.ok` (or `<storage>/p2p-verify.fail`) and exits. Dev
 * tooling — not public surface.
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

const P2P_TOPIC = Buffer.alloc(32, 7);
const P2P_TIMEOUT = 30_000;

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
    await withTimeout(serverJoin.flushed(), P2P_TIMEOUT, 'server discovery');

    let clientJoin = client.join(P2P_TOPIC, { server: true, client: true });
    await withTimeout(clientJoin.flushed(), P2P_TIMEOUT, 'client discovery');

    while (Date.now() - start < P2P_TIMEOUT && !echoReceived) {
      await sleep(1500);
      if (echoReceived) break;
      // Re-join to force a fresh lookup until the server's announce shows up.
      try {
        clientJoin.destroy();
      } catch {
        // Already destroyed.
      }
      clientJoin = client.join(P2P_TOPIC, { server: true, client: true });
      await clientJoin.flushed().catch(() => undefined);
    }

    if (!echoReceived) {
      const conns =
        `${server.peers.size}/${server.connections.size} server peers/conns, ` +
        `${client.peers.size}/${client.connections.size} client peers/conns`;
      const detail = errors.length
        ? `; errors: ${errors.slice(0, 3).join('; ')}`
        : '';
      throw new Error(
        `no p2p handshake/echo within ${P2P_TIMEOUT}ms (${conns}${detail})`,
      );
    }

    return Date.now() - start;
  } finally {
    await server.destroy().catch(() => undefined);
    await client.destroy().catch(() => undefined);
    await bootstrapper.destroy().catch(() => undefined);
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

  const roundtripMs = await verifyP2PHandshake(await reserveLoopbackPort());

  fs.writeFileSync(
    okMarker,
    `ok ${drive.key?.toString('hex') ?? ''} p2p-handshake ${roundtripMs}ms`,
  );
}

void run()
  .then(() => Bare.exit(0))
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    try {
      fs.writeFileSync(failMarker, message);
    } catch {
      // Marker dir missing; the exit code still signals failure.
    }
    Bare.exit(1);
  });
