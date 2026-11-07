import { ErrorCode } from './constants';
import { CoreError } from './types';

// Internal to the message layer: not re-exported from `index.ts`, so the public
// `@ekrooh/bare/core` surface is unchanged.

/** Longest `pluginId`, `event` or `requestId` a decoded header may carry.
 * Every id is echoed into responses and log lines, so an unbounded one could
 * push an error response past the header cap (mirrors the Kotlin host's
 * `MAX_FIELD_BYTES`). */
export const MAX_ID_LENGTH = 256;

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
