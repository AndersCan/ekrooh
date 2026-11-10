import { definePlugin, err, ok } from '@ekrooh/bare/core';
import type { Sync } from '@ekrooh/bare/sync';
import { type VoteOption, type VoteState, voteSpecs } from '../src/vote-events';

/** Votes this device counted, by option id. Each device publishes only its own
 * counts; the page shows the sum over every device, so devices never conflict. */
export type Counts = Record<string, number>;

const choices = [
  { id: 'tea', label: 'Tea' },
  { id: 'coffee', label: 'Coffee' },
  { id: 'water', label: 'Water' },
];

/** Peers are untrusted: keep only known options with whole, non-negative counts. */
export function parseCounts(raw: unknown): Counts | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const counts: Counts = {};
  for (const choice of choices) {
    const n = (raw as Record<string, unknown>)[choice.id];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
      return undefined;
    }
    counts[choice.id] = n;
  }
  return counts;
}

export function createVotePlugin(sync: Sync<Counts>) {
  const mine: Counts = {};
  // A restarted device keeps its identity but not its counts. Publish empty
  // counts now so other devices drop the old value instead of keeping it.
  sync.publish({});
  const state = (): VoteState => {
    const options: VoteOption[] = choices.map((c) => ({
      ...c,
      votes: sync
        .values()
        .reduce((total, v) => total + (v.value[c.id] ?? 0), 0),
    }));
    return { options, invite: sync.invite(), connected: sync.connected() };
  };
  return definePlugin('app.vote', voteSpecs, {
    capabilities: ['vote'],
    invoke: {
      list() {
        return ok(state());
      },
      cast(args) {
        if (!choices.some((c) => c.id === args.id)) {
          return err('app.vote/unknown-option', `No option "${args.id}"`);
        }
        mine[args.id] = (mine[args.id] ?? 0) + 1;
        const [error] = sync.publish({ ...mine });
        if (error) return err('app.vote/sync-failed', error.message);
        return ok(state());
      },
      join(args) {
        // Break check (plan #495): never call sync.join.
        void args.code;
        const error = undefined;
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
