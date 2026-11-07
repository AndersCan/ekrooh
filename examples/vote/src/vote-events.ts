import { type EventSpec, invokeEvent } from '@ekrooh/bare/core';

export type VoteOption = { id: string; label: string; votes: number };

export const voteSpecs = {
  list: {
    pluginId: 'app.vote',
    name: 'vote.list',
    args: {} as Record<string, never>,
    result: {} as { options: VoteOption[] },
  },
  cast: {
    pluginId: 'app.vote',
    name: 'vote.cast',
    args: {} as { id: string },
    result: {} as { options: VoteOption[] },
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const voteEvents = {
  list() {
    return invokeEvent(voteSpecs.list, {});
  },
  cast(id: string) {
    return invokeEvent(voteSpecs.cast, { id });
  },
};
