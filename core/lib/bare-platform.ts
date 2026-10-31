import crypto from 'bare-crypto';
import type { Platform } from '../messages/platform';

/** `Platform` for the Bare worklet, which has no Web Crypto global. */
export const barePlatform: Platform = {
  randomBytes: (bytes) => crypto.randomFillSync(bytes),
  now: Date.now,
};
