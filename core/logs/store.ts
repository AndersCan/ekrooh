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
  // Circular storage: `append` overwrites the oldest slot in O(1) instead of
  // shifting the whole array on every entry once full.
  const ring = Array.from<LogEntry | undefined>({ length: capacity });
  let start = 0;
  let size = 0;
  let seq = 0;

  /** Entries oldest-first. */
  function ordered(): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = 0; i < size; i++) {
      out.push(ring[(start + i) % capacity] as LogEntry);
    }
    return out;
  }

  return {
    get capacity() {
      return capacity;
    },
    append(entry) {
      const record = { ...entry, seq: seq++ };
      if (size < capacity) {
        ring[(start + size) % capacity] = record;
        size++;
      } else {
        ring[start] = record;
        start = (start + 1) % capacity;
      }
    },
    view(options: LogViewOptions = {}) {
      const { tail, level, source } = options;
      const filtered = ordered().filter(
        (e) =>
          (level === undefined || e.level === level) &&
          (source === undefined || e.source === source),
      );
      const count =
        tail === undefined ? filtered.length : Math.min(tail, filtered.length);
      return filtered.slice(filtered.length - count);
    },
    clear() {
      const cleared = size;
      ring.fill(undefined);
      start = 0;
      size = 0;
      return cleared;
    },
  };
}
