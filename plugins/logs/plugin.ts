import { definePlugin, ok, PluginManifest } from '../../core/messages';
import { LogStore } from '../../core/logs/types';
import { logsSpecs } from './events';

/** The framed invoke carries its response in a JSON header capped at
 * `MAX_HEADER_BYTES`, so `logs.view` stays a small bounded window — bulk
 * read-back lives on `GET /logs` instead. */
export const LOGS_VIEW_MAX_TAIL = 100;
const LOGS_VIEW_DEFAULT_TAIL = 20;

export type LogsPluginDeps = {
  /** Shared ring buffer fed by the worklet capture seam and the ingest route. */
  store: LogStore;
};

export function createLogsPlugin(deps: LogsPluginDeps): PluginManifest {
  return definePlugin('core.logs', logsSpecs, {
    capabilities: ['logs'],
    invoke: {
      view: (args) => {
        const tail =
          args?.tail === undefined
            ? LOGS_VIEW_DEFAULT_TAIL
            : Math.max(0, Math.min(args.tail, LOGS_VIEW_MAX_TAIL));
        return ok({
          entries: deps.store.view({
            tail,
            level: args?.level,
            source: args?.source,
          }),
        });
      },
      clear: () => ok({ cleared: deps.store.clear() }),
    },
  });
}
