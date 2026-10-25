# Research: p2p folder stack for the Bare runtime

Ticket #2. Requirements: folder = p2p unit, share-key invite, incremental sync of
hundreds of multi-MB photos, on-device (Android/iOS via `bare-kit` worklet), and a
WebView that reads only the loopback server's real-path mounts.

## Recommendation

**Hyperdrive on one Corestore per app.** A folder is a hyperdrive: `drive.key` is
the share key, `drive.discoveryKey` is the swarm topic. One worklet per app maps
onto one Corestore per app. Hyperdrive is a hyperbee metadata index plus hyperblobs
content store.

**v1 is single-writer.** Only the device holding the writer keypair can `put()`.
The folder creator owns it; invited members are readers who also seed. "Everyone
can add" uses the documented group pattern: each member has a drive, and the
creator mounts those into the folder drive (`my-group/userA/docs`).

**Autobase** is parked. Use it only if concurrent writes to shared metadata become
a hard requirement. Multi-MB payloads do not belong in autobase nodes.

## Options

- **Hyperdrive:** 64 KB blocks; sparse replication fetches only requested ranges
  (`createReadStream(start, end)`); `watch`/`diff` for incremental metadata;
  `mirror-drive` for folder diffs. Invite is one key. Single file read fetches only
  that file's blocks. Single-writer.
- **Raw hypercore:** works, but chunk order and offsets are managed by the app.
  Fallback when no directory semantics are wanted.
- **Hyperblobs (+hyperbee):** good for attachment-only object storage. Index and
  listing are the app's job. Two keys to manage.
- **Autobase:** multi-writer, but linearizer, per-writer and view cores. Most moving
  parts; storage and memory grow fast.

## Native addons (Android/iOS)

Three new addons, linked by the existing `bare-link --preset android|ios`
(`scripts/build-ios-app.mjs`, `examples/android-app/build.gradle`):

- `udx-native`: UDP and TCP for the DHT and peer connections (`engines.bare >=1.17.4`).
- `sodium-native`: Noise handshake, secretstream, hashing. Ships `.bare` prebuilds
  for android arm/arm64/x64 and ios-arm64.
- `rocksdb-native`: hypercore 11 storage (`hypercore-storage` is RocksDB-based;
  `engines.bare >=1.16.0`).

Corrections to the ticket's guesses: `bare-udp` does not exist on npm. `bare-dgram`
and `bare-net` are userland wrappers, not what the stack links (`dht-rpc` and
`hyperdht` use `udx-native` directly). `bare-crypto` is already a dependency and is
used by `rocksdb-native`.

## Caveats

- RocksDB is heavy: the npm tarball unpacks to about 168 MB, plus a large per-ABI
  library and memory footprint (hypercore issue #739).
- Android Doze and background throttling kill DHT discovery and seeding when the
  screen is off. The worklet suspend/resume lifecycle is the mitigation, so DHT is
  effectively foreground-only. Readers join with `{ client: true, server: false }`
  and need no inbound port. Only the seeding writer needs `server: true`.
- iOS needs a background mode or the same foreground-only stance. The holepunch
  bootstrap servers must be reachable.
- macOS dev pitfall (issue #28): killed swarm processes leave announce records in a
  long-lived local DHT bootstrap. They expire only after the 20-minute TTL, and fresh
  peers burn their connection budget on them. This is state, not an addon bug. The
  `smoke:p2p` worklet (`core/p2p-verify.core.ts`) uses an ephemeral loopback
  bootstrap. If `peers=0` or handshake timeouts persist in dev, restart the stale
  bootstrapper or wait out the TTL.

## Serving a remote file to the WebView

The loopback server mounts only real filesystem paths and streams them with `Range`
support (`core/server/static-file-server.ts:315`).

1. **Spool to disk (v1).** On first request, `drive.createReadStream(path)` into a
   file in the writable storage dir, then `loopbackServer.mount('/media/<id>', cachePath)`.
   Reuses the existing mount, range and auth path. The cache doubles as the offline
   copy. Costs disk, bounded by sparse core.
2. **Virtual-read seam (follow-up).** Add `mountStream(path, {size, readRange(start,end)})`
   to the loopback server. No copy and earlier first byte, but new framework surface
   and a reimplementation of range serving. File an issue; not a v1 blocker.

## Verdict

Hyperdrive. Incremental 64 KB-block sync of large binaries, one-key invite,
per-file on-demand reads, and one worklet with one corestore. Three new native
addons. Single-writer creator device, plus mounted per-member drives for "everyone
adds", is the v1 scope. Autobase stays parked.

Sources: https://github.com/holepunchto/hyperdrive,
https://github.com/holepunchto/mirror-drive,
https://github.com/holepunchto/autobase,
https://docs.pears.com/explanation/from-logs-to-files/,
https://blog.hypercore-protocol.org/posts/announcing-hyperdrive-10/,
https://docs.pears.com/how-to/stream-and-share-media/create-a-full-peer-to-peer-filesystem-with-hyperdrive/,
https://github.com/holepunchto/hypercore-storage,
https://www.npmjs.com/package/sodium-native,
https://www.npmjs.com/package/rocksdb-native,
https://developer.android.com/develop/background-work/background-tasks/bg-work-restrictions
