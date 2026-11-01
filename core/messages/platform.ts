/**
 * Environment capabilities the message layer needs but must not read from
 * globals: Bare has no Web Crypto global, so reaching for
 * `globalThis.crypto` broke host invokes in consumer worklets (ekrooh#268).
 * Each entry point injects its own implementation; tests override fields.
 */
export interface Platform {
  /** Fill `bytes` with CSPRNG output and return it. Never Math.random. */
  randomBytes(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  /** Milliseconds since the epoch. */
  now(): number;
}

/**
 * Fill in any field `override` leaves out from the Web platform (browser,
 * Node). Throws when a CSPRNG is needed but the environment has none, rather
 * than falling back to a guessable source (ekrooh#141).
 */
export function resolvePlatform(override: Partial<Platform> = {}): Platform {
  return {
    randomBytes: override.randomBytes ?? webRandomBytes(),
    now: override.now ?? Date.now,
  };
}

function webRandomBytes(): Platform['randomBytes'] {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof c?.getRandomValues !== 'function') {
    throw new Error(
      'ekrooh: no CSPRNG in this environment; pass `platform.randomBytes`',
    );
  }
  return (bytes) => c.getRandomValues(bytes);
}
