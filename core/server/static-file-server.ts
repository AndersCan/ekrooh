import fs from 'bare-fs';
import http from 'bare-http1';
import type {
  HTTPIncomingMessage,
  HTTPServerResponse,
  HTTPStatusCode,
} from 'bare-http1';
import ws from 'bare-ws';
import crypto from 'bare-crypto';
import path from 'bare-path';
import { TextDecoder } from 'bare-encoding';

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
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
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export function mimeTypeFor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** Extracts the `token` query param from a raw query string (`a=1&token=x`). */
export function tokenFromQuery(query: string): string | null {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) === 'token') return pair.slice(eq + 1);
  }
  return null;
}

/** Reads the token from the `X-Bare-Token` request header (parser-lowercased).
 * `fetch`-based non-browser clients that cannot carry cookies use this. */
export function tokenFromHeaders(
  headers: Record<string, string | number>,
): string | null {
  const value = headers['x-bare-token'];
  return typeof value === 'string' ? value : null;
}

/** Reads the `bare_session` value from the `Cookie` request header. */
export function cookieSession(
  headers: Record<string, string | number>,
): string | null {
  const cookie = headers['cookie'];
  if (typeof cookie !== 'string') return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === 'bare_session') {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** Derives the cookie value from the session token so the token itself is not
 * echoed into a request header a local attacker could read back. */
export function sessionNonce(token: string): string {
  return crypto.createHash('blake2b-256').update(token).digest('hex');
}

/** Parses a `Range: bytes=<start>-<end>` header. Returns `null` when absent or
 * unsatisfiable (caller falls back to a 200 full response). */
export function parseRange(
  value: string | number | undefined,
  size: number,
): { start: number; end: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  let start = match[1] === '' ? NaN : parseInt(match[1], 10);
  let end = match[2] === '' ? NaN : parseInt(match[2], 10);
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    // Suffix range: the last `end` bytes.
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (Number.isNaN(end)) end = size - 1;
    // Clamp so an overlong range never advertises a Content-Length bigger than
    // the bytes the stream will emit.
    end = Math.min(end, size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

/** Accumulates an HTTP request body into a UTF-8 string. Node http emits
 * Buffers, bare-http1 emits Uint8Arrays, and a setEncoding'd stream emits
 * strings — `String(uint8array)` would join bytes with commas, so decode
 * explicitly (the `/login` token body must match byte-for-byte). */
export function collectRequestBody(req: HTTPIncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    let body = '';
    req.on('data', (chunk: unknown) => {
      body +=
        typeof chunk === 'string'
          ? chunk
          : decoder.decode(chunk as Uint8Array, { stream: true });
    });
    req.on('end', () => resolve(body + decoder.decode(new Uint8Array(0))));
  });
}

export type WebSocketLike = {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  write(data: unknown): boolean;
  destroy(): void;
};

/** Minimal shape of the HTTP request object handed to WS upgrade handlers. */
export type LoopbackRequest = {
  url?: string;
  method?: string;
  headers: Record<string, string | number>;
};

export type LoopbackConnectionHandler = (
  socket: WebSocketLike,
  request: LoopbackRequest,
) => void;

export interface LoopbackServerOptions {
  /** Bind address. Defaults to `127.0.0.1`. */
  host?: string;
  /** Port to bind; `0` picks an ephemeral port (on-device). */
  port?: number;
  /** Require the per-session token/cookie on every request and WS upgrade.
   * The dev backend turns this off (the browser cannot know the token). */
  auth?: boolean;
  /** Fixed session token (dev/tests); otherwise a random 32-byte token is
   * generated on first bind. */
  token?: string;
  /** Idle timeout (ms) after which an authenticated WebSocket connection is
   * dropped. Defaults to 60s. */
  wsIdleTimeoutMs?: number;
}

export interface LoopbackServer {
  /** Resolves to the server origin (`http://127.0.0.1:<port>`), binding on
   * first use. */
  origin(): Promise<string>;
  /** Resolves to a URL for `path` (`<origin><path>`). The per-session cookie
   * authorizes media loads; no token is embedded in the URL anymore. */
  url(path: string): Promise<string>;
  /** The per-session token (generated on first bind). */
  token(): string;
  /** Resolves to the bound origin, port and token — written to the handoff
   * file for the host to read before loading the page. */
  credentials(): Promise<{ origin: string; port: number; token: string }>;
  /** Serves `filePath` at `http://<origin><path>` (exact match). */
  mount(path: string, filePath: string): void;
  unmount(path: string): void;
  /** Serves every file under `dirPath` below `prefix` (longest-prefix match),
   * with an SPA fallback to `dirPath/index.html` for unknown GET paths. */
  mountDir(prefix: string, dirPath: string): void;
  /** Registers a handler for authenticated, handshaken WebSocket connections
   * (the protocol socket). */
  onConnection(handler: LoopbackConnectionHandler): void;
  /** Stops accepting connections and closes the server. */
  close(cb?: (err?: Error | null) => void): void;
}

/**
 * The single loopback HTTP+WS server for the worklet. One origin serves the
 * web app (`/`), the media files mounted by plugins, and the framed-protocol
 * WebSocket socket the page connects to. On device it binds `127.0.0.1` on an
 * ephemeral port. The bundled web app (directory mounts) is public content — a
 * fresh WebView must load the page before the page can `POST /login`. Mounted
 * session files (media) and the WS upgrade are gated by a per-session token,
 * accepted as a `bare_session` cookie (set via `POST /login`), the
 * `X-Bare-Token` header, or a `?token=` query param — defense in depth for
 * non-browser clients. All responses send `Referrer-Policy: no-referrer` so
 * token-bearing URLs never leak through a Referer header.
 */
export function createLoopbackServer(
  options: LoopbackServerOptions = {},
): LoopbackServer {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const authEnabled = options.auth ?? true;
  const wsIdleTimeoutMs = options.wsIdleTimeoutMs ?? 60_000;

  const fileMounts = new Map<string, string>();
  const dirMounts = new Map<string, string>();
  const connectionHandlers: LoopbackConnectionHandler[] = [];
  let token: string | null = options.token ?? null;
  let boundOrigin = '';
  let originPromise: Promise<string> | null = null;
  let activeSocket: WebSocketLike | null = null;

  function isAuthorized(
    headers: Record<string, string | number>,
    query: string,
  ) {
    if (!authEnabled) return true;
    if (token === null) return false;
    if (tokenFromQuery(query) === token) return true;
    if (tokenFromHeaders(headers) === token) return true;
    return cookieSession(headers) === sessionNonce(token);
  }

  function writeError(
    res: HTTPServerResponse,
    status: HTTPStatusCode,
    message: string,
  ) {
    res.writeHead(status, {
      'Content-Type': 'text/plain',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(message);
  }

  function handleLogin(req: HTTPIncomingMessage, res: HTTPServerResponse) {
    void collectRequestBody(req).then((body) => {
      const accepted =
        !authEnabled || (token !== null && body.trim() === token);
      if (!accepted) {
        writeError(res, 401, 'Unauthorized');
        return;
      }
      // Dev mode (auth off) has no real token — still answer the login so the
      // page transport proceeds, but set no cookie.
      const headers: Record<string, string | number> = {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      };
      if (authEnabled && token !== null) {
        headers['Set-Cookie'] =
          `bare_session=${sessionNonce(token)}; HttpOnly; SameSite=Lax; Path=/`;
      }
      res.writeHead(200, headers);
      res.end('ok');
    });
  }

  /** Resolves a request path to a file mount, or a directory mount + relative
   * path. Directory mounts win on longest-prefix match. */
  function resolveMount(
    cleanPath: string,
  ):
    | { kind: 'file'; filePath: string }
    | { kind: 'dir'; dirPath: string; rel: string }
    | null {
    const fileMount = fileMounts.get(cleanPath);
    if (fileMount) return { kind: 'file', filePath: fileMount };
    let best: { dirPath: string; rel: string } | null = null;
    let bestPrefix = -1;
    for (const [prefix, dirPath] of dirMounts) {
      let rel: string;
      if (cleanPath === prefix) {
        rel = '';
      } else if (prefix === '/') {
        rel = cleanPath.replace(/^\/+/, '');
      } else if (cleanPath.startsWith(`${prefix}/`)) {
        rel = cleanPath.slice(prefix.length + 1);
      } else {
        continue;
      }
      if (prefix.length > bestPrefix) {
        best = { dirPath, rel };
        bestPrefix = prefix.length;
      }
    }
    return best ? { kind: 'dir', dirPath: best.dirPath, rel: best.rel } : null;
  }

  /** Resolves a directory-mount request to a concrete file, applying the SPA
   * fallback (unknown GET navigation → `index.html`). Subresource requests
   * (`Accept` without `text/html`) never fall back — a missing asset is a 404. */
  function resolveDirFile(
    mount: { kind: 'dir'; dirPath: string; rel: string },
    headers: Record<string, string | number>,
  ): string | null {
    const candidate =
      mount.rel === '' ? mount.dirPath : path.join(mount.dirPath, mount.rel);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Not a file — fall through to the directory index / SPA fallback.
    }
    // The mount root serves its `index.html` directly.
    if (mount.rel === '') {
      return indexHtmlIfPresent(mount.dirPath);
    }
    // SPA fallback only for navigations (browsers send `Accept: text/html` on
    // top-level GETs); a missing subresource must 404, not return HTML.
    const accept = headers['accept'];
    if (typeof accept !== 'string' || !accept.includes('text/html')) {
      return null;
    }
    return indexHtmlIfPresent(mount.dirPath);
  }

  function indexHtmlIfPresent(dirPath: string): string | null {
    try {
      const index = path.join(dirPath, 'index.html');
      const stat = fs.statSync(index);
      if (stat.isFile()) return index;
    } catch {
      // No index.html — 404.
    }
    return null;
  }

  function serveFile(
    req: HTTPIncomingMessage,
    res: HTTPServerResponse,
    filePath: string,
  ) {
    let stat: ReturnType<typeof fs.statSync>;
    try {
      stat = fs.statSync(filePath);
    } catch {
      writeError(res, 404, 'Not found');
      return;
    }
    if (!stat.isFile()) {
      writeError(res, 404, 'Not found');
      return;
    }
    const range = parseRange(req.headers['range'], stat.size);
    if (range) {
      res.writeHead(206, {
        'Content-Type': mimeTypeFor(filePath),
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': range.end - range.start + 1,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      });
      // Flush the headers immediately so bare-http1 does not append its own
      // (zero) Content-Length when the piped stream ends.
      (res as unknown as { flushHeaders(): void }).flushHeaders();
      pipeFile(res, filePath, range);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeTypeFor(filePath),
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    (res as unknown as { flushHeaders(): void }).flushHeaders();
    pipeFile(res, filePath);
  }

  /** Pipes a file's bytes to the response with an error handler. bare-fs opens
   * its fd asynchronously, so a file evicted between `statSync` and the open
   * (e.g. the spool LRU eviction in #8) emits `'error'` with no listeners —
   * an unhandled error would crash the whole worklet. Headers are flushed
   * before piping, so a mid-stream error aborts the response rather than
   * writing a late status. */
  function pipeFile(
    res: HTTPServerResponse,
    filePath: string,
    range?: { start: number; end: number },
  ) {
    const stream = range
      ? fs.createReadStream(filePath, {
          start: range.start,
          end: range.end,
        })
      : fs.createReadStream(filePath);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        const status =
          (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
        writeError(res, status, 'Failed to read file');
        return;
      }
      res.destroy();
    });
    stream.pipe(res);
  }

  const server = http.createServer((req, res) => {
    try {
      const requestUrl = req.url ?? '/';
      const [rawPath, query = ''] = requestUrl.split('?');
      // Normalize a trailing slash so `/media/<id>/` still matches the exact
      // file mount (and keeps its auth gate) instead of falling through to the
      // public directory mount.
      const cleanPath = rawPath.split('#')[0].replace(/\/+$/, '') || '/';
      const headers = req.headers as Record<string, string | number>;

      if (req.method === 'POST' && cleanPath === '/login') {
        handleLogin(req, res);
        return;
      }

      // Never let a path escape a mount root.
      if (cleanPath.split('/').includes('..')) {
        writeError(res, 400, 'Bad request');
        return;
      }

      const mount = resolveMount(cleanPath);
      // The bundled web app (directory mounts, e.g. `/`) is public content —
      // a fresh WebView must be able to load the page before `/login` runs.
      // Mounted session files (media) and the WS upgrade stay gated.
      const publicResource = mount !== null && mount.kind === 'dir';
      if (!publicResource && !isAuthorized(headers, query)) {
        writeError(res, 401, 'Unauthorized');
        return;
      }

      const filePath =
        mount === null
          ? null
          : mount.kind === 'file'
            ? mount.filePath
            : resolveDirFile(mount, headers);
      if (filePath === null) {
        writeError(res, 404, 'Not found');
        return;
      }
      serveFile(req, res, filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(message);
    }
  });

  function origin(): Promise<string> {
    if (!originPromise) {
      originPromise = new Promise<string>((resolve, reject) => {
        token ??= crypto
          .randomBytes(32)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        server.on('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          boundOrigin = `http://${host}:${address.port}`;
          resolve(boundOrigin);
        });
      });
    }
    return originPromise;
  }

  // WS upgrade: origin check, auth check, then handshake. Rejects before the
  // 101 so unauthenticated clients never complete a handshake. The origin
  // check is only meaningful on-device (auth on): the page is served by this
  // server, so its Origin matches. Dev runs cross-origin (Vite) with auth off.
  server.on('upgrade', (req, socket, head) => {
    const headers = req.headers as Record<string, string | number>;
    const [, query = ''] = (req.url ?? '').split('?');

    const origin = headers['origin'];
    if (
      authEnabled &&
      typeof origin === 'string' &&
      origin.length > 0 &&
      boundOrigin !== '' &&
      origin !== boundOrigin
    ) {
      socket.destroy();
      return;
    }

    if (!isAuthorized(headers, query)) {
      socket.destroy();
      return;
    }

    // Single-client policy: reject before the handshake so a refused second
    // socket never receives a 101 (a 101-then-close would look like an
    // established connection to the client's reconnect logic).
    if (activeSocket) {
      socket.destroy();
      return;
    }

    ws.Server.handshake(req as never, socket, head, (err) => {
      if (err) {
        socket.destroy(err);
        return;
      }
      const client = new ws.Socket({
        socket,
        isServer: true,
      } as unknown as ConstructorParameters<
        typeof ws.Socket
      >[0]) as unknown as WebSocketLike;
      activeSocket = client;
      client.on('close', () => {
        if (activeSocket === client) activeSocket = null;
      });
      // Idle timeout: bare-ws sockets are duplex streams; the underlying TCP
      // socket resets its timer on any traffic.
      socket.setTimeout(wsIdleTimeoutMs, () => client.destroy());
      for (const handler of connectionHandlers) {
        try {
          handler(client, req);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error('Error in loopback WS connection handler:', message);
        }
      }
    });
  });

  async function url(path: string): Promise<string> {
    return `${await origin()}${path}`;
  }

  return {
    origin,
    url,
    token() {
      return token ?? '';
    },
    async credentials() {
      const originUrl = await origin();
      return {
        origin: originUrl,
        port: Number(originUrl.slice(originUrl.lastIndexOf(':') + 1)),
        token: token!,
      };
    },
    mount(path, filePath) {
      fileMounts.set(path, filePath);
    },
    unmount(path) {
      fileMounts.delete(path);
    },
    mountDir(prefix, dirPath) {
      dirMounts.set(prefix, dirPath);
    },
    onConnection(handler) {
      connectionHandlers.push(handler);
    },
    close(cb) {
      if (activeSocket) {
        try {
          activeSocket.destroy();
        } catch {
          // Already closed.
        }
      }
      server.close(cb);
    },
  };
}
