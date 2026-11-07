import { definePlugin, err, ok } from '@ekrooh/bare/core';
import { type VoteOption, voteSpecs } from '../src/vote-events';

export function createVotePlugin() {
  const options: VoteOption[] = [
    { id: 'tea', label: 'Tea', votes: 0 },
    { id: 'coffee', label: 'Coffee', votes: 0 },
    { id: 'water', label: 'Water', votes: 0 },
  ];
  const snapshot = () => options.map((o) => ({ ...o }));
  return definePlugin('app.vote', voteSpecs, {
    capabilities: ['vote'],
    invoke: {
      list() {
        return ok({ options: snapshot() });
      },
      cast(args) {
        const option = options.find((o) => o.id === args.id);
        if (!option) {
          return err('app.vote/unknown-option', `No option "${args.id}"`);
        }
        option.votes += 1;
        return ok({ options: snapshot() });
      },
    },
  });
}
