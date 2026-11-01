import { describe, expect, it } from 'vite-plus/test';
import { barePlatform } from './bare-platform';

describe('barePlatform', () => {
  it('fills the given buffer from bare-crypto', () => {
    const bytes = new Uint8Array(32);
    expect(barePlatform.randomBytes(bytes)).toBe(bytes);
    expect(bytes.some((b) => b !== 0)).toBe(true);
  });
});
