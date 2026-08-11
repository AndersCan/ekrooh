export const VERSION = 1;

export const MessageType = {
  ENVELOPE: 1,
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/** Canonical error codes. Everything the framework throws uses these; peers
 * may carry arbitrary codes over the wire, but `CoreError.code` narrows on
 * this union. Keep `android/src/main/.../ErrorCodes.kt` in sync. */
export const ErrorCode = {
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
  UNSUPPORTED_EVENT: 'UNSUPPORTED_EVENT',
  HOST_ERROR: 'HOST_ERROR',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  PLUGIN_ERROR: 'PLUGIN_ERROR',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  FRAME_TOO_LARGE: 'FRAME_TOO_LARGE',
  FRAME_INVALID: 'FRAME_INVALID',
  TIMEOUT: 'TIMEOUT',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** A JSON header must fit a 16-bit big-endian length field. */
export const MAX_HEADER_BYTES = 0xffff;

/** Upper bound on one encoded frame. Large binary transfers are a plugin-level
 * concern (out-of-band handles), not an in-band payload. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
