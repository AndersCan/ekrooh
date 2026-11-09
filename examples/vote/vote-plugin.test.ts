import { describe, expect, it } from 'vite-plus/test';
import type { CoreError, Either } from '@ekrooh/bare/core';
import type { Sync, SyncValue } from '../../core/sync/sync-engine';
import {
  createVotePlugin,
  parseCounts,
  type Counts,
} from './worklet/vote-plugin';
import type { VoteState } from './src/vote-events';

type Fake = Sync<Counts> & { published: Counts[]; peers: SyncValue<Counts>[] };

function fakeSync(
  options: { publishError?: boolean; badJoin?: boolean } = {},
): Fake {
  const fake: Fake = {
    published: [],
    peers: [],
    invite: () => 'a'.repeat(32),
    join: () =>
      options.badJoin
        ? [{ code: 'bad', message: 'bad' } as CoreError, null]
        : [null, true],
    publish(value) {
      fake.published.push(value);
      if (options.publishError) {
        return [{ code: 'x', message: 'no room' } as CoreError, null];
      }
      // Self first, like the real engine.
      fake.peers = [
        { peer: 'me', self: true, value },
        ...fake.peers.filter((p) => !p.self),
      ];
      return [null, true];
    },
    values: () => fake.peers,
    connected: () => fake.peers.filter((p) => !p.self).length,
    onChange: () => () => {},
    close: async () => {},
  };
  return fake;
}

async function call(
  plugin: ReturnType<typeof createVotePlugin>,
  name: string,
  args: unknown,
): Promise<Either<CoreError, VoteState>> {
  const invoke = plugin.runtimes.bare?.invoke;
  if (!invoke) throw new Error('expected bare invoke adapter');
  return (await invoke(name, args, {
    runtime: 'bare',
    payload: new Uint8Array(0),
  })) as Either<CoreError, VoteState>;
}

const votes = (state: VoteState | null) =>
  Object.fromEntries((state?.options ?? []).map((o) => [o.id, o.votes]));

describe('parseCounts', () => {
  it('keeps known options with whole non-negative counts', () => {
    expect(parseCounts({ tea: 2, coffee: 0, other: 9 })).toEqual({
      tea: 2,
      coffee: 0,
    });
    expect(parseCounts({})).toEqual({});
  });

  it.each([
    ['null', null],
    ['array', [1]],
    ['string', 'tea'],
    ['negative', { tea: -1 }],
    ['fractional', { tea: 1.5 }],
    ['unsafe', { tea: Number.MAX_SAFE_INTEGER + 1 }],
    ['not a number', { tea: '1' }],
    ['NaN', { tea: Number.NaN }],
  ])('rejects %s', (_, raw) => {
    expect(parseCounts(raw)).toBeUndefined();
  });
});

describe('vote plugin', () => {
  it('publishes empty counts at start so a restart resets the old value', () => {
    const sync = fakeSync();
    createVotePlugin(sync);
    expect(sync.published).toEqual([{}]);
  });

  it('counts own votes and sums them with other devices', async () => {
    const sync = fakeSync();
    const plugin = createVotePlugin(sync);
    sync.peers.push({ peer: 'b', self: false, value: { tea: 2, coffee: 1 } });
    await call(plugin, 'vote.cast', { id: 'tea' });
    const [error, state] = await call(plugin, 'vote.cast', { id: 'tea' });
    expect(error).toBeNull();
    expect(votes(state)).toEqual({ tea: 4, coffee: 1, water: 0 });
    expect(state?.connected).toBe(1);
    expect(state?.invite).toBe('a'.repeat(32));
  });

  it('rejects an unknown option without publishing', async () => {
    const sync = fakeSync();
    const plugin = createVotePlugin(sync);
    const [error] = await call(plugin, 'vote.cast', { id: 'juice' });
    expect(error?.code).toBe('app.vote/unknown-option');
    expect(sync.published).toEqual([{}]);
  });

  it('returns sync-failed when publishing fails', async () => {
    const plugin = createVotePlugin(fakeSync({ publishError: true }));
    const [error] = await call(plugin, 'vote.cast', { id: 'tea' });
    expect(error?.code).toBe('app.vote/sync-failed');
  });

  it('returns bad-code when the join code is rejected', async () => {
    const plugin = createVotePlugin(fakeSync({ badJoin: true }));
    const [error] = await call(plugin, 'vote.join', { code: 'nope' });
    expect(error?.code).toBe('app.vote/bad-code');
  });

  it('returns the state after a good join', async () => {
    const plugin = createVotePlugin(fakeSync());
    const [error, state] = await call(plugin, 'vote.join', { code: 'x' });
    expect(error).toBeNull();
    expect(votes(state)).toEqual({ tea: 0, coffee: 0, water: 0 });
  });

  it('a restarted device starts at zero, not at its old votes', async () => {
    const first = createVotePlugin(fakeSync());
    await call(first, 'vote.cast', { id: 'water' });
    const sync = fakeSync();
    const second = createVotePlugin(sync);
    const [, state] = await call(second, 'vote.list', {});
    expect(votes(state).water).toBe(0);
  });
});
