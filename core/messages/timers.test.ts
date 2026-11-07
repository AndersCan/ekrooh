import { describe, expect, it } from 'vite-plus/test';
import { MAX_TIMER_MS, timerMs } from './timers';

describe('timerMs', () => {
  it('caps a delay at the 32-bit setTimeout limit (adv-A-7)', () => {
    expect(MAX_TIMER_MS).toBe(2147483647);
    expect(timerMs(2 ** 31, 5)).toBe(MAX_TIMER_MS);
    expect(timerMs(1e12, 5)).toBe(MAX_TIMER_MS);
    expect(timerMs(1000, 5)).toBe(1000);
  });

  it('falls back for missing, non-finite or non-positive delays', () => {
    for (const bad of [undefined, NaN, Infinity, -1, 0, '10']) {
      expect(timerMs(bad, 30_000)).toBe(30_000);
    }
  });
});
