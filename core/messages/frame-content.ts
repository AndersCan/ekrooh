import { ErrorCode } from './constants';
import { CoreError } from './types';

// Internal to the message layer: not re-exported from `index.ts`, so the public
// `@ekrooh/bare/core` surface is unchanged.

/** Longest `pluginId`, `event` or `requestId` a decoded header may carry, in
 * UTF-8 bytes (the unit the Kotlin and Swift hosts count). Every id is echoed
 * into responses and log lines, so an unbounded one could push an error
 * response past the header cap. */
export const MAX_ID_LENGTH = 256;

/** UTF-8 byte length of `str`, without a `TextEncoder` (Bare has no global
 * one). A lone surrogate counts as the 3-byte U+FFFD an encoder writes. */
export function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const unit = str.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** Whether `value` is a string within {@link MAX_ID_LENGTH} UTF-8 bytes. */
export function isShortId(value: unknown): value is string {
  // Each UTF-16 unit is at most 3 bytes, so a short string needs no count.
  if (typeof value !== 'string') return false;
  if (value.length * 3 <= MAX_ID_LENGTH) return true;
  return (
    value.length <= MAX_ID_LENGTH && utf8ByteLength(value) <= MAX_ID_LENGTH
  );
}

/** The routing fields of a header whose content was rejected, kept only when
 * each is a short string, so the receiver can still answer the request. */
export type RecoveredHeader = {
  type?: string;
  requestId?: string;
  pluginId?: string;
  event?: string;
};

/** A correctly delimited frame whose content is invalid (not UTF-8, not JSON,
 * an unknown header type, an over-long id, an over-deep value). The stream is
 * still in sync after it, so only this frame is dropped. */
export class FrameContentError extends CoreError {
  readonly recovered: RecoveredHeader | undefined;

  constructor(message: string, recovered?: RecoveredHeader) {
    super(ErrorCode.FRAME_INVALID, message);
    this.name = 'FrameContentError';
    this.recovered = recovered;
  }
}
