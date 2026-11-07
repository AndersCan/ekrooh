import { describe, expect, it } from 'vite-plus/test';
import {
  isMediaKind,
  MEDIA_HOST_TIMEOUT_MS,
  MEDIA_INVOKE_TIMEOUT_MS,
} from './kinds';

describe('media kinds', () => {
  it('accepts only the kinds the native picker understands', () => {
    expect(isMediaKind('image')).toBe(true);
    expect(isMediaKind('video')).toBe(true);
    for (const value of ['audio', '', '../x', 0, null, {}, ['image']]) {
      expect(isMediaKind(value)).toBe(false);
    }
  });

  it('gives the host a deadline under the page timeout', () => {
    expect(MEDIA_HOST_TIMEOUT_MS).toBeLessThan(MEDIA_INVOKE_TIMEOUT_MS);
    expect(MEDIA_HOST_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});
