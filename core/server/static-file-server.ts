import fs from 'bare-fs';
import http from 'bare-http1';
import crypto from 'bare-crypto';

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
};

function mimeTypeFor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** Extracts the `token` query param from a raw query string (`a=1&token=x`). */
function tokenFromQuery(query: string): string | null {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) === 'token') return pair.slice(eq + 1);
  }
  return null;
}

/** Reads the token from the `X-Bare-Token` request header (lowercased by the
 * parser), for `fetch`-based clients that can set headers. Media elements
 * (`<img>`/`<video>`) cannot set headers, so they carry the token in the URL
 * query instead. */
function tokenFromHeaders(
  headers: Record<string, string | number>,
): string | null {
  const value = headers['x-bare-token'];
  if (typeof value === 'string') return value;
  const cased = headers['X-Bare-Token'];
  return typeof cased === 'string' ? cased : null;
}

/**
 * Loopback HTTP file server for the worklet. Large binary transfers (images,
 * video) never cross the wire protocol or a WebView bridge: a plugin mounts
 * host-side files here and returns a URL the web layer loads directly. One
 * implementation serves every runtime (iOS, Android, desktop, browser).
 *
 * The server binds 127.0.0.1 on an ephemeral port and only serves paths that
 * were explicitly mounted — never arbitrary filesystem access.
 *
 * Every endpoint is gated by a per-session token: a random 32-byte base64url
 * value generated on first bind. A local attacker app on the device can reach
 * loopback, so requests without a matching token are rejected with 401 before
 * any mount lookup or serving happens. The token is accepted via the `?token=`
 * query param (media elements can't set headers) or the `X-Bare-Token` header
 * (`fetch`-based clients). All responses send `Referrer-Policy: no-referrer`
 * so a token-bearing URL never leaks through a Referer header.
 */
export interface StaticFileServer {
  /** Resolves to the server origin (`http://127.0.0.1:<port>`), binding on
   * first use. */
  origin(): Promise<string>;
  /** Resolves to a token-authenticated URL for `path` (`<origin><path>?token=...`),
   * binding on first use. */
  url(path: string): Promise<string>;
  /** Serves `filePath` at `http://<origin><path>`. */
  mount(path: string, filePath: string): void;
  unmount(path: string): void;
}

export function createStaticFileServer(options?: {
  host?: string;
}): StaticFileServer {
  const host = options?.host ?? '127.0.0.1';
  const mounts = new Map<string, string>();
  let originPromise: Promise<string> | null = null;
  let token: string | null = null;

  const server = http.createServer((req, res) => {
    try {
      const requestUrl = req.url ?? '/';
      const [path, query = ''] = requestUrl.split('?');
      const cleanPath = path.split('#')[0];
      const headers = req.headers as Record<string, string | number>;
      const presented = tokenFromQuery(query) ?? tokenFromHeaders(headers);
      if (token === null || presented !== token) {
        res.writeHead(401, {
          'Content-Type': 'text/plain',
          'Referrer-Policy': 'no-referrer',
        });
        res.end('Unauthorized');
        return;
      }
      const filePath = mounts.get(cleanPath);
      if (!filePath) {
        res.writeHead(404, {
          'Content-Type': 'text/plain',
          'Referrer-Policy': 'no-referrer',
        });
        res.end('Not found');
        return;
      }
      // Reference implementation reads whole files; stream for large media in
      // production (bare-fs.createReadStream + pipe).
      const read = fs.readFileSync(filePath);
      const data = typeof read === 'string' ? Buffer.from(read) : read;
      res.writeHead(200, {
        'Content-Type': mimeTypeFor(filePath),
        'Content-Length': data.byteLength,
        'Access-Control-Allow-Origin': '*',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(message);
    }
  });

  function origin(): Promise<string> {
    if (!originPromise) {
      originPromise = new Promise<string>((resolve, reject) => {
        token = crypto
          .randomBytes(32)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        server.on('error', reject);
        server.listen(0, host, () => {
          const address = server.address();
          resolve(`http://${host}:${address.port}`);
        });
      });
    }
    return originPromise;
  }

  async function url(path: string): Promise<string> {
    return `${await origin()}${path}?token=${token}`;
  }

  return {
    origin,
    url,
    mount(path, filePath) {
      mounts.set(path, filePath);
    },
    unmount(path) {
      mounts.delete(path);
    },
  };
}
