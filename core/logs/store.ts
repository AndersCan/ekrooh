import { LogEntry, LogStore, LogViewOptions } from './types';

/** Bounded FIFO log buffer. Newest entries are retained; the oldest are
 * dropped once `capacity` is exceeded. `seq` is a monotonic counter assigned
 * on append and shared across every source, so read-back stays ordered. */
export function createLogRingBuffer(capacity: number): LogStore {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(
      `log ring capacity must be a positive integer (got ${capacity})`,
    );
  }
  const buffer: LogEntry[] = [];
  let seq = 0;

  return {
    get capacity() {
      return capacity;
    },
    append(entry) {
      buffer.push({ ...entry, seq: seq++ });
      if (buffer.length > capacity) buffer.shift();
    },
    view(options: LogViewOptions = {}) {
      const { tail, level, source } = options;
      const filtered = buffer.filter(
        (e) =>
          (level === undefined || e.level === level) &&
          (source === undefined || e.source === source),
      );
      const count =
        tail === undefined ? filtered.length : Math.min(tail, filtered.length);
      return filtered.slice(filtered.length - count);
    },
    clear() {
      const cleared = buffer.length;
      buffer.length = 0;
      return cleared;
    },
  };
}
