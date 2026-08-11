import { ErrorCode } from './constants';
import { CoreError } from './types';
import type { Either } from './types';

/** Success half of an `Either` tuple. */
export function ok<T>(result: T): [null, T] {
  return [null, result];
}

/** Failure half of an `Either` tuple using a canonical error code. */
export function err(code: ErrorCode, message: string): [CoreError, null] {
  return [new CoreError(code, message), null];
}

/** Convenience for constructing a `CoreError` from a possibly-non-canonical
 * wire code: preserves known codes, maps anything else to `PLUGIN_ERROR`. */
export function coerceErrorCode(code: string | undefined): ErrorCode {
  if (code && code in ErrorCode) return code as ErrorCode;
  return ErrorCode.PLUGIN_ERROR;
}

export type Ok<T> = [null, T];
export type Err = [CoreError, null];
export type PluginResult<T> = Either<CoreError, T>;
