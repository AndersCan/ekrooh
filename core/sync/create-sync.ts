import Hyperswarm from 'hyperswarm';
import type { CoreError, Either } from '../messages/types';
import {
  createSyncWith,
  type Sync,
  type SyncOptions,
  type SyncValue,
  type SwarmPort,
} from './sync-engine';

export type { Sync, SyncOptions, SyncValue };

/** Peer-to-peer sync of one JSON value per device. Each device publishes its
 * own value; `values()` returns the latest value of every device in the room.
 * Worklet only. */
export function createSync<T>(
  options: SyncOptions<T>,
): Either<CoreError, Sync<T>> {
  return createSyncWith(options, {
    createSwarm: (seed) =>
      new Hyperswarm({ seed, maxPeers: 0 }) as unknown as SwarmPort,
  });
}
