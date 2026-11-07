import type { LogLevel, LogSource } from '../../core/logs/types';

/** Internal (not an `exports` entry): runtime checks for `logs.view` args.
 * Event specs are types only, so the page can send any JSON value. */
export const LOG_LEVELS: readonly LogLevel[] = [
  'debug',
  'info',
  'warn',
  'error',
];
export const LOG_SOURCES: readonly LogSource[] = ['backend', 'web'];

export function isLogLevel(value: unknown): value is LogLevel {
  return (LOG_LEVELS as readonly unknown[]).includes(value);
}

export function isLogSource(value: unknown): value is LogSource {
  return (LOG_SOURCES as readonly unknown[]).includes(value);
}
