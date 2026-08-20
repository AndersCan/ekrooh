import { LogLevel } from './types';

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';

const LEVEL_BY_METHOD: Record<ConsoleMethod, LogLevel> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
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

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  return args.map((a) => safeStringify(a)).join(' ');
}

export type WebConsoleCaptureOptions = {
  /** Ingest endpoint. Same-origin `/logs` on the loopback server. */
  endpoint?: string;
  /** Max entries buffered before a flush is issued. */
  flushThreshold?: number;
  /** Flush interval (ms); pass 0 to disable the interval. */
  flushIntervalMs?: number;
  /** Injectable ingest function (defaults to a same-origin POST fetch). */
  ingest?: (payload: {
    source: 'web';
    entries: Array<{ level: LogLevel; tag?: string; message: string }>;
  }) => void | Promise<void>;
};

export type WebConsoleCapture = {
  /** Flushes any buffered entries immediately (fire-and-forget). */
  flush(): void;
  /** Restores the original console methods captured at install time. */
  restore(): void;
};

function isFetchAvailable(): boolean {
  return typeof fetch === 'function';
}

/**
 * Web-side console capture: wraps the console methods, buffers formatted
 * entries, and flushes them as a batch to the loopback `POST /logs` ingest
 * route with `source: 'web'` (same-origin fetch). Every step is try/catch-
 * wrapped so the seam can never break the app. Skip installing in mock mode,
 * where there is no loopback backend to ingest into.
 */
export function installWebConsoleCapture(
  options: WebConsoleCaptureOptions = {},
): WebConsoleCapture {
  const {
    endpoint = '/logs',
    flushThreshold = 25,
    flushIntervalMs = 1000,
    ingest,
  } = options;

  const original: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  const pending: Array<{ level: LogLevel; tag?: string; message: string }> = [];

  function flush() {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    let flushed: unknown;
    try {
      flushed = ingest
        ? ingest({ source: 'web', entries: batch })
        : isFetchAvailable()
          ? fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source: 'web', entries: batch }),
            }).catch(() => undefined)
          : undefined;
    } catch {
      // A failed ingest must never surface to the app; drop the batch.
      return;
    }
    if (flushed) void Promise.resolve(flushed).catch(() => undefined);
  }

  const wrap = (method: ConsoleMethod, level: LogLevel) => {
    return (...args: unknown[]) => {
      try {
        pending.push({ level, message: formatArgs(args) });
        if (pending.length >= flushThreshold) flush();
      } catch {
        // Never let the seam break a consumer's own log call.
      }
      try {
        original[method].apply(console, args);
      } catch {
        // Never let a broken consumer logger break the app.
      }
    };
  };

  console.debug = wrap('debug', 'debug');
  console.log = wrap('log', 'info');
  console.info = wrap('info', 'info');
  console.warn = wrap('warn', 'warn');
  console.error = wrap('error', 'error');

  const timer =
    flushIntervalMs > 0 ? setInterval(flush, flushIntervalMs) : undefined;

  return {
    flush,
    restore() {
      if (timer !== undefined) clearInterval(timer);
      console.debug = original.debug;
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

export { LEVEL_BY_METHOD };
