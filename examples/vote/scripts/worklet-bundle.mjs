import { createHash } from 'node:crypto';

export const bundlePath = '/__vote/worklet/android.bundle';

/** Quoted 8-hex ETag of the bundle bytes. */
export function etagFor(bytes) {
  return `"${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}"`;
}

/** True when If-None-Match names this etag (any entry, `W/` ignored). */
export function matchesEtag(header, etag) {
  if (typeof header !== 'string') return false;
  return header
    .split(',')
    .some((part) => part.trim().replace(/^W\//, '') === etag);
}

/**
 * Serves the packed Android worklet at `bundlePath`: 200 with an ETag, 304
 * when the caller already has it, 503 before the first pack succeeds. Any
 * other path goes on to `next()`.
 */
export function createBundleRoute() {
  let current;
  return {
    set(bytes) {
      current = { bytes, etag: etagFor(bytes) };
    },
    handle(req, res, next) {
      if (req.url?.split('?')[0] !== bundlePath) return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        return res.end();
      }
      if (!current) {
        res.statusCode = 503;
        return res.end('worklet is not packed yet');
      }
      res.setHeader('ETag', current.etag);
      if (matchesEtag(req.headers['if-none-match'], current.etag)) {
        res.statusCode = 304;
        return res.end();
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', current.bytes.length);
      res.statusCode = 200;
      res.end(req.method === 'HEAD' ? undefined : current.bytes);
    },
  };
}
