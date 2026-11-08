import { err, ok } from '../messages/errors';
import type { CoreError, Either } from '../messages/types';

/** Largest encoded line `publish` accepts. */
export const MAX_VALUE_BYTES = 16 * 1024;
/** Largest line a peer may send before the connection is dropped. */
export const MAX_LINE_BYTES = 32 * 1024;

/** One wire line: `{"v":1,"value":<json>}\n`. */
export function encodeSyncLine(value: unknown): Either<CoreError, string> {
  let json: string | undefined;
  try {
    json = JSON.stringify({ v: 1, value });
  } catch {
    json = undefined;
  }
  if (json === undefined || JSON.stringify(value) === undefined) {
    return err('sync/not-json', 'Sync values must be JSON.');
  }
  const line = `${json}\n`;
  if (Buffer.byteLength(line) > MAX_VALUE_BYTES) {
    return err(
      'sync/value-too-large',
      'Sync values must be under 16 KiB of JSON.',
    );
  }
  return ok(line);
}

export type LineReader = { push(chunk: Uint8Array | string): void };

/** Splits a byte stream into lines. A line longer than `maxBytes` without a
 * newline calls `onOverflow` once and the reader goes quiet. */
export function createLineReader(options: {
  maxBytes: number;
  onLine: (line: string) => void;
  onOverflow: () => void;
}): LineReader {
  let pending = Buffer.alloc(0);
  let dead = false;
  return {
    push(chunk) {
      if (dead) return;
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      for (;;) {
        const end = pending.indexOf(0x0a);
        if (end === -1) break;
        const line = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + 1);
        if (line.length > 0) options.onLine(line);
      }
      if (pending.length > options.maxBytes) {
        dead = true;
        pending = Buffer.alloc(0);
        options.onOverflow();
      }
    },
  };
}
