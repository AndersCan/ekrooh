import { EventSpec, invokeEvent, InvokeEnvelope } from '../../core/messages';
import { LogEntry, LogLevel, LogSource } from '../../core/logs/types';

export type { LogEntry, LogLevel, LogSource } from '../../core/logs/types';

export type LogsViewArgs = {
  /** Most-recent N matching entries. Defaults to a small window. */
  tail?: number;
  level?: LogLevel;
  source?: LogSource;
};

export type LogsViewResult = {
  entries: LogEntry[];
};

export type LogsClearResult = {
  cleared: number;
};

export const logsSpecs = {
  view: {
    pluginId: 'core.logs',
    name: 'logs.view',
    args: {} as LogsViewArgs,
    result: {} as LogsViewResult,
  },
  clear: {
    pluginId: 'core.logs',
    name: 'logs.clear',
    args: {} as Record<string, never>,
    result: {} as LogsClearResult,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const logEvents = {
  logs: {
    view(
      options: LogsViewArgs = {},
    ): InvokeEnvelope<'logs.view', LogsViewArgs, LogsViewResult> {
      return invokeEvent(logsSpecs.view, options);
    },
    clear(): InvokeEnvelope<
      'logs.clear',
      Record<string, never>,
      LogsClearResult
    > {
      return invokeEvent(logsSpecs.clear, {});
    },
  },
};
