# Research: p2p folder stack for the Bare runtime

Ticket #2. Decision-oriented findings for the photo-folder app: folder = p2p unit,
share-key invite, incremental sync of hundreds of multi-MB photos, on-device
(Android/iOS via `bare-kit` worklet), and a WebView that only ever reads the
loopback server's real-path mounts.

## Recommendation

**Hyperdrive on one Corestore per app.** A folder _is_ a hyperdrive: `drive.key`
is the share key, `drive.discoveryKey` is the Hyperswarm topic, and the existing
single-worklet-per-app model maps 1:1 onto "one Corestore per application"
(https://docs.pears.com/how-to/store-and-replicate/work-with-many-hypercores-using-corestore/).
Hyperdrive is exactly a hyperbee metadata index + hyperblobs content store
(https://docs.pears.com/explanation/from-logs-to-files/), which is what a folder
of photos needs, and it is the module holepunch's own apps ship on mobile.

**v1 is single-writer:** hyperdrive is a single-writer structure — only the
device holding the writer keypair can `put()`
(https://blog.hypercore-protocol.org/posts/announcing-hyperdrive-10/). The
folder's _creator_ owns it; invited members are readers who also seed. "Everyone
can add" then uses the documented group pattern: each member has their own drive
and the creator mounts it into the folder drive
(`my-group/userA/docs`), the folder drive being the share unit
(https://blog.hypercore-protocol.org/posts/announcing-hyperdrive-10/,
https://docs.pears.com/how-to/stream-and-share-media/create-a-full-peer-to-peer-filesystem-with-hyperdrive/).
Reach for **autobase** only if concurrent writes to _shared metadata_ become a
hard requirement — it linearizes a causal DAG with quorum-based checkpoints and
rebases views (https://github.com/holepunchto/autobase), which is real complexity
(multi-MB binary payloads do _not_ belong inside autobase nodes).

## Options

|                               | Hyperdrive                                                                                                                                                                                                                                                                                                            | Raw hypercore                                                                                                                   | Hyperblobs (+hyperbee)                                                                                                                                          | Autobase                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Incremental large-binary sync | Excellent: blobs split into 64 KB blocks; sparse replication pulls only requested ranges (`drive.createReadStream(start,end)`); `drive.watch`/`drive.diff` for incremental metadata; `mirror-drive` for whole-folder diffing (https://github.com/holepunchto/hyperdrive, https://github.com/holepunchto/mirror-drive) | Doable but manual: you track chunk order/offsets and fetching yourself (https://docs.pears.com/explanation/from-logs-to-files/) | Good: `Hyperblobs.get(id, {start,length})` over a content core; you still build the index and path listing yourself (https://github.com/holepunchto/hyperblobs) | Overkill: linearizer replays events through a pure `apply()`; blobs would live in per-writer cores, indexes in the view — by far the most moving parts |
| Invite model                  | One key: share `drive.key`, join `drive.discoveryKey` on the swarm (https://docs.pears.com/reference/building-blocks/hyperdrive/)                                                                                                                                                                                     | Share core key + topic — same idea, no path semantics                                                                           | Share blobs core key + a separate index; two keys to manage                                                                                                     | Share base key; membership via `addWriter` protocol                                                                                                    |
| Serve a single remote file    | `drive.createReadStream('/x.jpg', {start,end})` fetches only that file's blocks; `entry(path).value.blob` gives exact blob bounds                                                                                                                                                                                     | Read blocks yourself                                                                                                            | `blobs.createReadStream(id, {start,length})`                                                                                                                    | View is usually hyperbee; content still needs a blob core                                                                                              |
| Storage layout                | Corestore dir per app; metadata bee core + content blobs core, all in RocksDB-backed storage (https://github.com/holepunchto/hypercore-storage)                                                                                                                                                                       | Single core in corestore                                                                                                        | One content core (+ your index core)                                                                                                                            | System + per-writer + view cores; storage and memory balloon                                                                                           |
| Multi-writer                  | No (mounts compose per-user drives)                                                                                                                                                                                                                                                                                   | No                                                                                                                              | No                                                                                                                                                              | Yes — that is its point                                                                                                                                |

Raw hypercore is the "just the log" fallback when you want zero directory
semantics; hyperblobs is what you'd pick for attachment-only object storage; both
leave the folder index and list UI to you, which is the app's actual product
surface.

## Native addons on Android/iOS

The stack links **three new native addons** on device, resolved by the same
`bare-link --preset android|ios` already wired in this repo
(`scripts/build-ios-app.mjs`, `examples/android-app/build.gradle`):

- `udx-native` — UDP **and** TCP for the DHT and peer connections
  (`dht-rpc` → `udx-native`; `engines.bare >=1.17.4`)
  (https://github.com/holepunchto/udx-native)
- `sodium-native` — Noise handshake + libsodium secretstream + hypercore hashing
  (ships `.bare` prebuilds for `android-arm/arm64/x64` and `ios-arm64`, sims;
  https://www.npmjs.com/package/sodium-native)
- `rocksdb-native` — hypercore v11's storage engine (`hypercore-storage` is
  built on RocksDB; `rocksdb-native` is a Bare addon, `engines.bare >=1.16.0`,
  imports `bare-fs`/`bare-path`/`bare-crypto` under Bare)
  (https://github.com/holepunchto/hypercore-storage,
  https://www.npmjs.com/package/rocksdb-native)

Myth-busting the ticket's guesses: `bare-udp` does not exist on npm; `bare-dgram`
and `bare-net` are userland wrappers (over `udx-native`/`bare-tcp`), not what the
p2p stack links — `dht-rpc` and `hyperdht` use `udx-native` directly. `bare-crypto`
is already a repo dependency and _is_ used (rocksdb-native's bare import map).

Known gaps / caveats:

- **RocksDB is heavy** (the npm tarball alone unpacks ~168 MB; expect a large
  per-ABI `.so`/framework and memory footprint). Real cost of hypercore 11
  (https://github.com/holepunchto/hypercore/issues/739).
- **UDP + Android backgrounding**: Doze/background throttling kills DHT
  discovery and seeding when the screen is off
  (https://developer.android.com/develop/background-work/background-tasks/bg-work-restrictions);
  the `bare-kit` worklet lifecycle (suspend/resume) is the mitigation, so DHT is
  foreground-only in practice. Readers can join `{ client: true, server: false }`
  (no open inbound port needed); only the seeding writer needs `server: true`
  (https://docs.pears.com/how-to/stream-and-share-media/create-a-full-peer-to-peer-filesystem-with-hyperdrive/).
- iOS: sockets need a background mode (or same foreground-only stance) and the
  holepunch bootstrap servers must be reachable.

## Serving a remote peer's file to the WebView

The loopback server only mounts real filesystem paths and pipes
`fs.createReadStream` with `Range` support
(`core/server/static-file-server.ts:315`). Two seams:

1. **Spool-to-disk (recommended for v1).** On first request for a remote photo,
   `drive.createReadStream(path)` → `fs.createWriteStream` into the writable
   storage dir, then `loopbackServer.mount('/media/<id>', cachePath)`. Reuses the
   existing mount + byte-range + auth path unchanged; the cache doubles as the
   offline copy. Cost: downloaded bytes already live in the RocksDB core store,
   so this copies them (disk, but sparse core keeps it bounded).
2. **Virtual-read seam (follow-up).** Add a `mountStream(path, {size, readRange(start,end)})`
   to the loopback server that pipes a `drive.createReadStream` range instead of
   a file — no copy, first-byte earlier, but new framework surface and a
   reimplementation of range serving.

v1 should spool; the seam is worth an issue, not a blocker.

## Verdict

Hyperdrive. It gives incremental 64 KB-block sync of large binaries, a one-key
invite, per-file on-demand reads, and matches the one-worklet/one-corestore app
shape with only three new native addons. Single-writer ownership (creator's
device) with per-member mounted drives for "everyone adds" is the v1 scope;
autobase stays parked for real shared-metadata multi-writer.
