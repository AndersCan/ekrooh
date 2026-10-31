import { describe, expect, it } from 'vite-plus/test';
import { resolvePlatform } from './platform';

describe('resolvePlatform', () => {
  it('defaults to Web Crypto and Date.now', () => {
    const p = resolvePlatform();
    expect(p.randomBytes(new Uint8Array(32)).some((b) => b !== 0)).toBe(true);
    expect(Math.abs(p.now() - Date.now())).toBeLessThan(1000);
  });

  it('keeps injected fields', () => {
    expect(resolvePlatform({ now: () => 1 }).now()).toBe(1);
  });

  it('throws instead of falling back when no CSPRNG exists', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    });
    try {
      expect(() => resolvePlatform()).toThrow(/no CSPRNG/);
      // An injected source needs no global.
      expect(() => resolvePlatform({ randomBytes: (b) => b })).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'crypto', original!);
    }
  });
});
