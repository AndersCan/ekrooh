import { err, ok } from '../messages/errors';
import type { CoreError, Either } from '../messages/types';
import { parseInviteCode, topicForInvite } from './invite';
import { loadSyncState, saveSyncState } from './sync-state-file';
import { MAX_LINE_BYTES, createLineReader, encodeSyncLine } from './wire';

export type SyncOptions<T> = {
  /** Existing directory for this device's sync identity and current room.
   * Pass `runtime.config.storage`. Without it (or if it is missing/unwritable)
   * identity and room live in memory and a restart starts a new room. */
  storage?: string;
  /** Validates a peer's value. Return the typed value, or undefined to drop
   * it. Required. */
  parse: (raw: unknown) => T | undefined;
};

export type SyncValue<T> = { peer: string; self: boolean; value: T };

export interface Sync<T> {
  /** This device's current room code: 32 lowercase hex chars. */
  invite(): string;
  /** Leave the current room and join the one named by `code`. */
  join(code: string): Either<CoreError, true>;
  /** Replace this device's value and send it to every connected device. */
  publish(value: T): Either<CoreError, true>;
  /** Latest value of every device seen in this room: self first, then by peer id. */
  values(): SyncValue<T>[];
  /** Devices connected right now (not counting this one). */
  connected(): number;
  /** Called after a peer value changes, a device connects or disconnects, or
   * join() succeeds. Returns unsubscribe. */
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
}

/** The slice of a Hyperswarm connection the engine uses. */
export interface ConnPort {
  remotePublicKey: Uint8Array;
  write(data: string): unknown;
  on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
  on(event: 'error', cb: (error: unknown) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  destroy(): unknown;
}

/** The slice of a Hyperswarm the engine uses; tests supply a fake. */
export interface SwarmPort {
  keyPair: { publicKey: Uint8Array };
  on(event: 'connection', cb: (conn: ConnPort) => void): unknown;
  on(event: 'error', cb: (error: unknown) => void): unknown;
  /** Hyperswarm returns a PeerDiscovery; `refresh()` looks the topic up again. */
  join(
    topic: Buffer,
    opts: { server: boolean; client: boolean },
  ): { refresh(): unknown } | undefined | void;
  leave(topic: Buffer): unknown;
  destroy(): unknown;
}

type Peer<T> = {
  conns: Set<ConnPort>;
  raw: string | undefined;
  value: T | undefined;
  warned: Set<string>;
};

/** While alone in a room, look it up again this often. Hyperswarm's own next
 * lookup is 10+ minutes away, so a lookup that missed the other device (it
 * announced a moment ago, or this device's network was still starting) would
 * otherwise leave both alone. */
const REDISCOVER_MS = 15_000;

/** Most devices a room remembers; matches the swarm's maxPeers. */
const MAX_PEERS = 16;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export function createSyncWith<T>(
  options: SyncOptions<T>,
  deps: { createSwarm(seed: Buffer): SwarmPort },
): Either<CoreError, Sync<T>> {
  const [stateError, state] = loadSyncState(options.storage);
  if (stateError !== null) return [stateError, null];

  const swarm = deps.createSwarm(Buffer.from(state.seed, 'hex'));
  const selfId = hex(swarm.keyPair.publicKey);
  const peers = new Map<string, Peer<T>>();
  const listeners = new Set<() => void>();
  let room = state.room;
  let topic = topicForInvite(room);
  let selfLine: string | undefined;
  let selfValue: T | undefined;
  let closed = false;
  let rediscover: ReturnType<typeof setInterval> | undefined;

  const fire = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[sync] onChange listener failed: ${message}`);
      }
    }
  };

  const connected = () => {
    let count = 0;
    for (const peer of peers.values()) if (peer.conns.size > 0) count++;
    return count;
  };

  const peerFor = (id: string): Peer<T> => {
    const existing = peers.get(id);
    if (existing !== undefined) return existing;
    const created: Peer<T> = {
      conns: new Set(),
      raw: undefined,
      value: undefined,
      warned: new Set(),
    };
    peers.set(id, created);
    return created;
  };

  const prune = () => {
    for (const [id, peer] of peers) {
      if (peers.size <= MAX_PEERS) return;
      if (peer.conns.size === 0) peers.delete(id);
    }
  };

  const warnOnce = (peer: Peer<T>, key: string, message: string) => {
    if (peer.warned.has(key)) return;
    peer.warned.add(key);
    console.warn(message);
  };

  const joinTopic = () => {
    const discovery = swarm.join(topic, { server: true, client: true });
    clearInterval(rediscover);
    rediscover = setInterval(() => {
      if (connected() > 0) return;
      try {
        void Promise.resolve(discovery?.refresh()).catch(() => {});
      } catch {
        // A refresh that throws is retried at the next tick.
      }
    }, REDISCOVER_MS);
    console.log(`[sync] in room ${room.slice(0, 4)}…`);
  };

  swarm.on('error', () => {});

  swarm.on('connection', (conn) => {
    conn.on('error', () => {});
    const id = hex(conn.remotePublicKey);
    if (closed || id === selfId) {
      conn.destroy();
      return;
    }
    const short = id.slice(0, 8);
    const peer = peerFor(id);
    peer.conns.add(conn);
    console.log(`[sync] peer ${short} connected (${connected()} connected)`);
    if (selfLine !== undefined) conn.write(selfLine);

    const reader = createLineReader({
      maxBytes: MAX_LINE_BYTES,
      onOverflow: () => {
        console.warn(
          `[sync] peer ${short} sent an oversized message; disconnected`,
        );
        conn.destroy();
      },
      onLine: (line) => {
        if (!peer.conns.has(conn)) return;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          warnOnce(peer, 'json', `[sync] peer ${short} sent a bad message`);
          return;
        }
        const record =
          typeof message === 'object' && message !== null
            ? (message as Record<string, unknown>)
            : {};
        if (record.v !== 1) {
          warnOnce(
            peer,
            'version',
            `[sync] peer ${short} uses sync v${String(record.v)}; update @ekrooh/bare on both devices`,
          );
          return;
        }
        let parsed: T | undefined;
        try {
          parsed = options.parse(record.value);
        } catch {
          parsed = undefined;
        }
        if (parsed === undefined) {
          warnOnce(
            peer,
            'parse',
            `[sync] peer ${short} sent a value this app does not accept`,
          );
          return;
        }
        if (peer.raw === line) return;
        peer.raw = line;
        peer.value = parsed;
        fire();
      },
    });
    conn.on('data', (chunk) => reader.push(chunk));
    conn.on('close', () => {
      if (!peer.conns.delete(conn)) return;
      console.log(
        `[sync] peer ${short} disconnected (${connected()} connected)`,
      );
      prune();
      fire();
    });
    fire();
  });

  joinTopic();

  const sync: Sync<T> = {
    invite: () => room,
    join(code) {
      if (closed) return err('sync/closed', 'This sync was closed.');
      const [error, next] = parseInviteCode(code);
      if (error !== null) return [error, null];
      if (next === room) return ok(true);
      void Promise.resolve(swarm.leave(topic)).catch(() => {});
      const old = [...peers.values()].flatMap((p) => [...p.conns]);
      for (const peer of peers.values()) peer.conns.clear();
      peers.clear();
      for (const conn of old) conn.destroy();
      room = next;
      topic = topicForInvite(room);
      saveSyncState(options.storage, { ...state, room });
      joinTopic();
      fire();
      return ok(true);
    },
    publish(value) {
      if (closed) return err('sync/closed', 'This sync was closed.');
      const [error, line] = encodeSyncLine(value);
      if (error !== null) return [error, null];
      selfLine = line;
      selfValue = value;
      for (const peer of peers.values()) {
        for (const conn of peer.conns) conn.write(line);
      }
      return ok(true);
    },
    values() {
      const out: SyncValue<T>[] = [];
      if (selfValue !== undefined) {
        out.push({ peer: selfId, self: true, value: selfValue });
      }
      const ids = [...peers.keys()].sort();
      for (const id of ids) {
        const value = peers.get(id)?.value;
        if (value !== undefined) out.push({ peer: id, self: false, value });
      }
      return out;
    },
    connected,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(rediscover);
      listeners.clear();
      await Promise.resolve(swarm.destroy()).catch(() => {});
    },
  };
  return ok(sync);
}
