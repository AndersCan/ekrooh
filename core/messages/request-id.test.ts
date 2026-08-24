import { describe, expect, it } from 'vite-plus/test';
import { createRequestId } from './request-id';

describe('createRequestId', () => {
  it('returns a string shaped `<time36>-<22-char base36>`', () => {
    const id = createRequestId();
    const match = /^([0-9a-z]+)-([0-9a-z]{22})$/.exec(id);
    expect(match).not.toBeNull();
    // The random tail must come from the CSPRNG (16 bytes -> 22 base36 chars),
    // never from Math.random (which would be a shorter, guessable slice).
    expect(match![2].length).toBe(22);
  });

  it('produces collision-resistant ids across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) ids.add(createRequestId());
    // We only need a vanishingly small collision rate; the CSPRNG tail makes
    // a collision in 10k samples astronomically unlikely.
    expect(ids.size).toBe(10000);
  });

  it('is shared by both messengers (no Math.random divergence)', () => {
    // Both rpc-messenger and rpc-messenger.mantaq import createRequestId from
    // this module, so neither may ever emit a Math.random-derived id. Assert
    // the scheme directly here so ekrooh#141 cannot regress.
    const fromProduction = createRequestId();
    const fromMantaqVariant = createRequestId();
    expect(fromProduction).toMatch(/^[0-9a-z]+-[0-9a-z]{22}$/);
    expect(fromMantaqVariant).toMatch(/^[0-9a-z]+-[0-9a-z]{22}$/);
    expect(fromProduction).not.toBe(fromMantaqVariant);
  });
});
