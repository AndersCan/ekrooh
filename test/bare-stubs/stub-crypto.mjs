import * as crypto from 'node:crypto';

// Node stand-in for the `bare-crypto` builtin used by the vitest alias in
// vite.config.js. Loopback auth hashes with blake2b-256, which OpenSSL does
// not expose, so remap it to sha256 (matching the per-file vi.mock stubs).
export default {
  ...crypto,
  createHash(algorithm, options) {
    if (algorithm === 'blake2b-256') algorithm = 'sha256';
    return crypto.createHash(algorithm, options);
  },
};
