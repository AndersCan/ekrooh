import { definePlugin, err, ok } from '@ekrooh/bare/core';
import type { Sync } from '@ekrooh/bare/sync';
import { type VoteState, voteSpecs } from '../src/vote-events';

/** Votes this device counted, by option id. Each device publishes only its own
 * counts; the page shows the sum over every device, so devices never conflict. */
export type Counts = Record<string, number>;

/** An option id is what devices share: a-z, 0-9 and -, 1 to 32 characters. */
export function isOptionId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9-]{1,32}$/.test(id);
}

/** Peers are untrusted: keep only valid option ids, and reject the whole value
 * if a count is not a whole, non-negative number. */
export function parseCounts(raw: unknown): Counts | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const counts: Counts = {};
  for (const [id, n] of Object.entries(raw)) {
    if (!isOptionId(id)) continue;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
      return undefined;
    }
    counts[id] = n;
  }
  return counts;
}

export function createVotePlugin(sync: Sync<Counts>) {
  const mine = new Map<string, number>();
  // A restarted device keeps its identity but not its counts. Publish empty
  // counts now so other devices drop the old value instead of keeping it.
  sync.publish({});
  const state = (): VoteState => {
    const votes = new Map<string, number>();
    for (const v of sync.values()) {
      for (const [id, n] of Object.entries(v.value)) {
        votes.set(id, (votes.get(id) ?? 0) + n);
      }
    }
    return {
      votes: Object.fromEntries(votes),
      invite: sync.invite(),
      connected: sync.connected(),
    };
  };
  return definePlugin('app.vote', voteSpecs, {
    capabilities: ['vote'],
    invoke: {
      list() {
        return ok(state());
      },
      cast(args) {
        if (!isOptionId(args.id)) {
          return err(
            'app.vote/bad-option',
            'Option ids use a-z, 0-9 and - (1 to 32 characters).',
          );
        }
        mine.set(args.id, (mine.get(args.id) ?? 0) + 1);
        const [error] = sync.publish(Object.fromEntries(mine));
        if (error) return err('app.vote/sync-failed', error.message);
        return ok(state());
      },
      join(args) {
        const [error] = sync.join(args.code);
        if (error) {
          return err(
            'app.vote/bad-code',
            'That code does not look right. Copy it again from the other device.',
          );
        }
        return ok(state());
      },
    },
  });
}
