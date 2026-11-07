import {
  definePlugin,
  err,
  ErrorCode,
  ok,
  PluginManifest,
} from '../../core/messages';
import { LogStore } from '../../core/logs/types';
import { isLogLevel, isLogSource } from './args';
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
        // Event specs are types only: the page can send any JSON value. A
        // non-number `tail` (`"all"`, `{}`) would otherwise turn into NaN and
        // return the whole ring past the cap; an unknown `level`/`source`
        // would silently widen the filter. Reject them instead.
        const rawTail: unknown = args?.tail;
        if (
          rawTail !== undefined &&
          (typeof rawTail !== 'number' || !Number.isFinite(rawTail))
        ) {
          return err(
            ErrorCode.PLUGIN_ERROR,
            'logs.view: tail must be a number',
          );
        }
        const level: unknown = args?.level;
        if (level !== undefined && !isLogLevel(level)) {
          return err(ErrorCode.PLUGIN_ERROR, 'logs.view: unknown level');
        }
        const source: unknown = args?.source;
        if (source !== undefined && !isLogSource(source)) {
          return err(ErrorCode.PLUGIN_ERROR, 'logs.view: unknown source');
        }
        const tail =
          rawTail === undefined
            ? LOGS_VIEW_DEFAULT_TAIL
            : Math.max(0, Math.min(Math.trunc(rawTail), LOGS_VIEW_MAX_TAIL));
        return ok({ entries: deps.store.view({ tail, level, source }) });
      },
      clear: () => ok({ cleared: deps.store.clear() }),
    },
  });
}
