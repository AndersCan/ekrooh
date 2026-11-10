import { LogLevel, LogSource, LogStore } from './types';

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type ConsoleCaptureOptions = {
  /** Lowest level recorded in the store. Lower-level calls still reach the
   * original console but skip formatting and storage. Defaults to `debug`
   * (record everything). */
  minLevel?: LogLevel;
};

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Longest captured backend message, in UTF-16 code units. The ring holds a
 * fixed number of entries, so this (with the ingest caps in `routes.ts`) is
 * what bounds its memory: a backend line can echo page-supplied text (a
 * plugin error, a rejected header), and must not pin capacity × that. */
export const MAX_CAPTURED_MESSAGE_CHARS = 16 * 1024;

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  const message = args.map((a) => safeStringify(a)).join(' ');
  return message.length > MAX_CAPTURED_MESSAGE_CHARS
    ? `${message.slice(0, MAX_CAPTURED_MESSAGE_CHARS)}…`
    : message;
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
  options: ConsoleCaptureOptions = {},
): ConsoleCapture {
  const minRank = LEVEL_RANK[options.minLevel ?? 'debug'];
  const original: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  const wrap = (method: ConsoleMethod, level: LogLevel) => {
    const recorded = LEVEL_RANK[level] >= minRank;
    return (...args: unknown[]) => {
      if (recorded) {
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
