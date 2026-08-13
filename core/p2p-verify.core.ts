import Corestore from 'corestore';
import Hyperdrive from 'hyperdrive';
import Hyperswarm from 'hyperswarm';
import fs from 'bare-fs';
import path from 'bare-path';

/** Global provided by the Bare runtime. */
declare const Bare: { argv?: string[]; exit(code: number): void };

/**
 * Dev verification worklet (ticket #24): proves the p2p native addons
 * (rocksdb-native via corestore, sodium-native via hyperdrive/hypercore,
 * udx-native via hyperswarm's DHT) actually run on a target runtime. Booted
 * under `bare` (macOS smoke) or inside the iOS reference app (simulator):
 * opens a Corestore, writes/reads through a Hyperdrive, constructs a
 * Hyperswarm (binds udx), then writes `<storage>/p2p-verify.ok` (or
 * `<storage>/p2p-verify.fail`) and exits. Dev tooling — not public surface.
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

async function run() {
  const corestore = new Corestore(path.join(storageDir, 'corestore'));
  await corestore.ready();

  const drive = new Hyperdrive(corestore);
  await drive.put('/verify.txt', Buffer.from('p2p verify ok'));
  const data = await drive.get('/verify.txt');
  if (data?.toString() !== 'p2p verify ok') {
    throw new Error(`hyperdrive readback mismatch: ${data?.toString()}`);
  }

  const swarm = new Hyperswarm({ bootstrap: [] });
  swarm.join(Buffer.alloc(32, 1));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await swarm.destroy();

  fs.writeFileSync(okMarker, `ok ${drive.key?.toString('hex') ?? ''}`);
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
