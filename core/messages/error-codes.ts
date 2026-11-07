import { ErrorCode } from './constants';

// Internal to the message layer: not re-exported from `index.ts`.

/** Whether `code` is one of the canonical {@link ErrorCode} values. Own
 * properties only, so `toString` or `__proto__` never match. */
export function isCanonicalErrorCode(code: unknown): code is ErrorCode {
  return (
    typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(ErrorCode, code) &&
    (ErrorCode as Record<string, string>)[code] === code
  );
}
