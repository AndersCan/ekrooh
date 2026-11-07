import { ErrorCode } from './constants';
import { isCanonicalErrorCode } from './error-codes';
import { CoreError, type ErrorCodeOrString } from './types';
import type { Either } from './types';

/** Success half of an `Either` tuple. */
export function ok<T>(result: T): [null, T] {
  return [null, result];
}

/** Failure half of an `Either` tuple. Accepts a canonical error code or any
 * app-scoped code (`app.photos/not-found`) — the code is preserved verbatim. */
export function err(
  code: ErrorCodeOrString,
  message: string,
): [CoreError, null] {
  return [new CoreError(code, message), null];
}

/** Convenience for constructing a `CoreError` from a possibly-non-canonical
 * wire code: preserves known codes, maps anything else to `PLUGIN_ERROR`.
 * Framework callers that want app codes preserved construct the error
 * directly instead. */
export function coerceErrorCode(code: string | undefined): ErrorCode {
  return isCanonicalErrorCode(code) ? code : ErrorCode.PLUGIN_ERROR;
}
export type Ok<T> = [null, T];
export type Err = [CoreError, null];
export type PluginResult<T> = Either<CoreError, T>;
