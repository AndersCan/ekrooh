import { describe, expect, it } from 'vite-plus/test';
import { isLogLevel, isLogSource } from './args';

describe('logs.view arg checks', () => {
  it('accepts only canonical levels and sources', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(isLogLevel(level)).toBe(true);
    }
    for (const source of ['backend', 'web']) {
      expect(isLogSource(source)).toBe(true);
    }
    for (const value of ['fatal', '', 1, null, {}, ['info']]) {
      expect(isLogLevel(value)).toBe(false);
      expect(isLogSource(value)).toBe(false);
    }
  });
});
