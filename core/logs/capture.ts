import { LogLevel, LogSource, LogStore } from './types';

const LEVEL_BY_METHOD: Record<ConsoleMethod, LogLevel> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  return args.map((a) => safeStringify(a)).join(' ');
}

/** Handle from {@link installConsoleCapture} so a consumer can tear the seam
 * down (tests, hot reload). */
export type ConsoleCapture = {
  readonly source: LogSource;
  readonly store: LogStore;
  /** Restores the original console methods captured at install time. */
  restore(): void;
};

/**
 * Installs console interception at startup: binds the original console methods,
 * forwards to them (so dev stdout and e2e console assertions stay intact), and
 * feeds a {@link LogStore}. Every step is try/catch-wrapped so a failure in the
 * seam can never break boot or swallow the consumer's own log call.
 */
export function installConsoleCapture(
  store: LogStore,
  source: LogSource = 'backend',
): ConsoleCapture {
  const original: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  const wrap = (method: ConsoleMethod, level: LogLevel) => {
    return (...args: unknown[]) => {
      try {
        store.append({
          ts: Date.now(),
          level,
          source,
          message: formatArgs(args),
        });
      } catch {
        // Never let the seam break a consumer's own log call.
      }
      try {
        original[method].apply(console, args);
      } catch {
        // Never let a broken consumer logger break boot.
      }
    };
  };

  console.debug = wrap('debug', 'debug');
  console.log = wrap('log', 'info');
  console.info = wrap('info', 'info');
  console.warn = wrap('warn', 'warn');
  console.error = wrap('error', 'error');

  return {
    source,
    store,
    restore() {
      console.debug = original.debug;
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

export { LEVEL_BY_METHOD };
