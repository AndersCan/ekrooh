export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSource = 'backend' | 'web';

export interface LogEntry {
  /** Monotonic sequence assigned by the store on append. */
  seq: number;
  /** Epoch millisecond timestamp. */
  ts: number;
  level: LogLevel;
  source: LogSource;
  tag?: string;
  message: string;
}

export interface LogViewOptions {
  /** Most-recent N matching entries. Omit for all. */
  tail?: number;
  level?: LogLevel;
  source?: LogSource;
}

export interface LogStore {
  /** Maximum number of entries retained (oldest dropped first). */
  readonly capacity: number;
  /** Appends an entry, assigning its `seq`. */
  append(entry: Omit<LogEntry, 'seq'>): void;
  /** Returns a snapshot of matching entries, newest-last, bounded by `tail`. */
  view(options?: LogViewOptions): LogEntry[];
  /** Empties the buffer. Returns the number of entries dropped. */
  clear(): number;
}
