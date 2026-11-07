import { describe, expect, it } from 'vite-plus/test';
import { diagnosticsEnabled } from './diagnostics';

describe('consumer-basic diagnosticsEnabled (adv-E-1)', () => {
  it('is on in dev or with VITE_BARE_DIAGNOSTICS=true, off otherwise', () => {
    expect(diagnosticsEnabled({ DEV: true })).toBe(true);
    expect(
      diagnosticsEnabled({ VITE_BARE_DIAGNOSTICS: 'true', DEV: false }),
    ).toBe(true);
    expect(diagnosticsEnabled({ PROD: true, DEV: false })).toBe(false);
  });
});
