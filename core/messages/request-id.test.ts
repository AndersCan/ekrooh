import { describe, expect, it } from 'vite-plus/test';
import { createRequestId } from './request-id';
import { resolvePlatform } from './platform';

const platform = resolvePlatform();

describe('createRequestId', () => {
  it('returns a string shaped `<time36>-<22-char base36>`', () => {
    const id = createRequestId(platform);
    const match = /^([0-9a-z]+)-([0-9a-z]{22})$/.exec(id);
    expect(match).not.toBeNull();
    // The random tail must come from the CSPRNG (16 bytes -> 22 base36 chars),
    // never from Math.random (which would be a shorter, guessable slice).
    expect(match![2].length).toBe(22);
  });

  it('produces collision-resistant ids across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) ids.add(createRequestId(platform));
    // We only need a vanishingly small collision rate; the CSPRNG tail makes
    // a collision in 10k samples astronomically unlikely.
    expect(ids.size).toBe(10000);
  });

  it('matches the CSPRNG id scheme (no Math.random divergence)', () => {
    // The messenger and the host IPC bridge both use this module, so neither
    // may ever emit a Math.random-derived id. Assert the scheme directly here
    // so ekrooh#141 cannot regress.
    const a = createRequestId(platform);
    const b = createRequestId(platform);
    expect(a).toMatch(/^[0-9a-z]+-[0-9a-z]{22}$/);
    expect(b).toMatch(/^[0-9a-z]+-[0-9a-z]{22}$/);
    expect(a).not.toBe(b);
  });

  it('uses the injected platform, never a global (ekrooh#268)', () => {
    const id = createRequestId({
      randomBytes: (b) => b.fill(1),
      now: () => 36,
    });
    expect(id).toBe(`10-${'1'.repeat(16)}`);
  });
});
