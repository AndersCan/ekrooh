import { definePlugin, ok } from '@ekrooh/bare/core';
import { LoopbackPush } from '@ekrooh/bare/runtime';
import { basicBeepHeader, basicSpecs } from '../shared/basic-events';

export type BasicPluginDeps = {
  /** The runtime's backend → web push seam (see docs consumers/backend-push.mdx). */
  push: LoopbackPush;
};

/**
 * The consumer's own plugin (`app.basic`) — the smallest possible event
 * surface: one invoke (`basic.ping`) and one backend → web push
 * (`basic.beep`). Every ping also pushes a beep, so the roundtrip is
 * deterministic and the real-stack e2e can assert both directions.
 */
export function createBasicPlugin(deps: BasicPluginDeps) {
  let beepCount = 0;
  return definePlugin('app.basic', basicSpecs, {
    capabilities: ['basic'],
    invoke: {
      ping(args) {
        beepCount += 1;
        deps.push(basicBeepHeader(beepCount));
        return ok({ message: args?.message ?? 'pong', ts: Date.now() });
      },
    },
  });
}
