import { describe, expect, it } from 'vite-plus/test';
import { ErrorCode } from './constants';
import { isCanonicalErrorCode } from './error-codes';

describe('isCanonicalErrorCode', () => {
  it('accepts every canonical code', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(isCanonicalErrorCode(code)).toBe(true);
    }
  });

  it('rejects inherited properties, app-scoped codes and non-strings (C-5)', () => {
    for (const code of [
      'toString',
      '__proto__',
      'constructor',
      'app.photos/not-found',
      '',
      undefined,
      42,
    ]) {
      expect(isCanonicalErrorCode(code)).toBe(false);
    }
  });
});
