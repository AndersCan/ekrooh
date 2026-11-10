import { describe, expect, it } from 'vite-plus/test';
import type { CoreError, Either } from '@ekrooh/bare/core';
import type { Sync, SyncValue } from '../../core/sync/sync-engine';
import {
  createVotePlugin,
  parseCounts,
  type Counts,
} from './worklet/vote-plugin';
import type { VoteState } from './src/vote-events';
import { createJoinWait, submitJoin } from './src/join-wait';
import { connectionText, pageView } from './src/render';

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

const votes = (state: VoteState | null) => state?.votes ?? {};

describe('parseCounts', () => {
  it('keeps valid option ids with whole non-negative counts', () => {
    expect(
      parseCounts(JSON.parse('{"tea":2,"pizza":1,"Tea":9,"__proto__":1}')),
    ).toEqual({ tea: 2, pizza: 1 });
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
    sync.peers.push({
      peer: 'b',
      self: false,
      value: { tea: 2, coffee: 1, pizza: 5 },
    });
    await call(plugin, 'vote.cast', { id: 'tea' });
    const [error, state] = await call(plugin, 'vote.cast', { id: 'tea' });
    expect(error).toBeNull();
    expect(votes(state)).toEqual({ tea: 4, coffee: 1, pizza: 5 });
    expect(state?.connected).toBe(1);
    expect(state?.invite).toBe('a'.repeat(32));
  });

  it('counts an id no one listed, summed with a peer', async () => {
    const sync = fakeSync();
    const plugin = createVotePlugin(sync);
    sync.peers.push({ peer: 'b', self: false, value: { pizza: 2 } });
    const [, state] = await call(plugin, 'vote.cast', { id: 'pizza' });
    expect(votes(state).pizza).toBe(3);
  });

  it('counts an id named like an Object property', async () => {
    const plugin = createVotePlugin(fakeSync());
    const [, state] = await call(plugin, 'vote.cast', { id: 'constructor' });
    expect(votes(state).constructor).toBe(1);
  });

  it.each([
    ['capital', 'Pizza'],
    ['too long', 'a'.repeat(33)],
    ['empty', ''],
    ['not a string', 7],
  ])('rejects a %s option id without publishing', async (_, id) => {
    const sync = fakeSync();
    const plugin = createVotePlugin(sync);
    const [error] = await call(plugin, 'vote.cast', { id });
    expect(error?.code).toBe('app.vote/bad-option');
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
    expect(votes(state)).toEqual({});
  });

  it('a restarted device starts at zero, not at its old votes', async () => {
    const sync = fakeSync();
    const first = createVotePlugin(sync);
    await call(first, 'vote.cast', { id: 'water' });
    const second = createVotePlugin(sync);
    const [, state] = await call(second, 'vote.list', {});
    expect(votes(state)).toEqual({});
  });
});

describe('connectionText', () => {
  it.each([
    [0, undefined, 'No other device yet'],
    [0, 0, 'Joined. Looking for the other device…'],
    [0, 59, 'Joined. Looking for the other device…'],
    [1, 30, '1 other device connected'],
    [2, undefined, '2 other devices connected'],
  ])('(%i, %s)', (connected, waiting, text) => {
    expect(connectionText(connected, waiting)).toBe(text);
  });

  it('after a minute tells you to restart both apps', () => {
    expect(connectionText(0, 60)).toContain('restart both apps');
  });
});

describe('join wait', () => {
  it('counts seconds from a join until a device connects', () => {
    let t = 1000;
    const wait = createJoinWait(() => t);
    expect(wait.seconds(0)).toBeUndefined();
    wait.joined(true);
    t += 61_500;
    expect(wait.seconds(0)).toBe(61);
    expect(wait.seconds(1)).toBeUndefined();
    expect(wait.seconds(0)).toBeUndefined();
  });

  it('a failed join does not start the wait', () => {
    let t = 0;
    const wait = createJoinWait(() => t);
    wait.joined(false);
    t += 5000;
    expect(wait.seconds(0)).toBeUndefined();
  });

  it('pageView passes the connected count to the wait', () => {
    const seen: number[] = [];
    const wait = {
      seconds: (c: number) => {
        seen.push(c);
        return c === 0 ? 7 : undefined;
      },
    };
    const state = { connected: 2 } as VoteState;
    expect(pageView(undefined, '', wait)).toEqual({ kind: 'loading' });
    expect(pageView(state, 'hi', wait)).toEqual({
      kind: 'ready',
      state,
      message: 'hi',
      waiting: undefined,
    });
    expect(seen).toEqual([2]);
  });

  it('a good join clears the box, a failed one keeps the text', async () => {
    const good = { value: 'abc' };
    await submitJoin(good, async () => true);
    expect(good.value).toBe('');
    const bad = { value: 'abc' };
    await submitJoin(bad, async () => false);
    expect(bad.value).toBe('abc');
  });
});
