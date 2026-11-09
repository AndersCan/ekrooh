import { type EventSpec, invokeEvent } from '@ekrooh/bare/core';

export type VoteOption = { id: string; label: string; votes: number };

/** What the page shows: totals across all devices, this device's invite code
 * and how many other devices are connected right now. */
export type VoteState = {
  options: VoteOption[];
  invite: string;
  connected: number;
};

export const voteSpecs = {
  list: {
    pluginId: 'app.vote',
    name: 'vote.list',
    args: {} as Record<string, never>,
    result: {} as VoteState,
  },
  cast: {
    pluginId: 'app.vote',
    name: 'vote.cast',
    args: {} as { id: string },
    result: {} as VoteState,
  },
  join: {
    pluginId: 'app.vote',
    name: 'vote.join',
    args: {} as { code: string },
    result: {} as VoteState,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const voteEvents = {
  list() {
    return invokeEvent(voteSpecs.list, {});
  },
  cast(id: string) {
    return invokeEvent(voteSpecs.cast, { id });
  },
  join(code: string) {
    return invokeEvent(voteSpecs.join, { code });
  },
};
