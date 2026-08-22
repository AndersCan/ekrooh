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

/** Reads the token from the `X-Bare-Token` request header (parser-lowercased).
 * `fetch`-based non-browser clients that cannot carry cookies use this.
 * Security note: like the `bare_session` cookie, this credential travels the
 * cleartext 127.0.0.1 loopback — it is only trusted from the bound origin
 * (enforced by `originAllowed`), and is an escape hatch for same-loopback
 * non-browser clients; it is accepted over TLS-agnostic plain HTTP by design. */
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

/** Constant-time string comparison. bare-crypto's `timingSafeEqual` requires
 * equal-length inputs (it throws otherwise), so guard on byte length first. */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
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
export function collectRequestBody(
  req: HTTPIncomingMessage,
  maxBytes = Infinity,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let body = '';
    let exceeded = false;
    req.on('data', (chunk: unknown) => {
      const str =
        typeof chunk === 'string'
          ? chunk
          : decoder.decode(chunk as Uint8Array, { stream: true });
      body += str;
      if (body.length > maxBytes) exceeded = true;
    });
    req.on('end', () => {
      const final = body + decoder.decode(new Uint8Array(0));
      if (exceeded || final.length > maxBytes) {
        reject(new Error('Request body too large'));
        return;
      }
      resolve(final);
    });
  });
}

export type WebSocketLike = {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  write(data: unknown): boolean;
  destroy(): void;
};

/** Handler for a registered HTTP route on the loopback server. */
export type LoopbackRouteHandler = (
  req: HTTPIncomingMessage,
  res: HTTPServerResponse,
) => void;

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
  /** The per-session token (generated on first bind). The host reads it from
   * `credentials()` for its own IPC needs — never injects it into the page. */
  token(): string;
  /** Resolves to the bound origin, port, token and a one-time bootstrap nonce —
   * written to the handoff file for the host to read before loading the page.
   * The host injects `bootstrap` into the page (not the token); the page
   * exchanges it once via `POST /login` for the HttpOnly session cookie. */
  credentials(): Promise<{
    origin: string;
    port: number;
    token: string;
    bootstrap: string;
  }>;
  /** Serves `filePath` at `http://<origin><path>` (exact match). */
  mount(path: string, filePath: string): void;
  unmount(path: string): void;
  /** Serves every file under `dirPath` below `prefix` (longest-prefix match).
   * The SPA fallback to `dirPath/index.html` for unknown nave GETs applies
   * only to `public` mounts (the bootstrap web app). Pass `{ public: true }`
   * to mark a mount as world-readable bootstrap content served before auth; a
   * non-public directory mount gates every request behind the session. */
  mountDir(prefix: string, dirPath: string, opts?: { public?: boolean }): void;
  /** Registers a handler for authenticated, handshaken WebSocket connections
   * (the protocol socket). */
  onConnection(handler: LoopbackConnectionHandler): void;
  /** Registers an HTTP route. `handler` runs before mount resolution, after
   * the auth gate (device mode requires the session cookie/token). The route
   * body is read with `collectRequestBody`. */
  registerRoute(
    method: string,
    path: string,
    handler: LoopbackRouteHandler,
  ): void;
  /** Writes a raw frame to the connected protocol socket (if any) — the
   * server-initiated push seam (e.g. a `photos.changed` dispatch). */
  push(frame: Uint8Array): boolean;
  /** Stops accepting connections and closes the server. */
  close(cb?: (err?: Error | null) => void): void;
}

/**
 * The single loopback HTTP+WS server for the worklet. One origin serves the
 * web app (`/`), the media files mounted by plugins, and the framed-protocol
 * WebSocket socket the page connects to. On device it binds `127.0.0.1` on an
 * ephemeral port. Only the explicit **bootstrap** directory mount (`/`, marked
 * `{ public: true }`) is world-readable before auth — a fresh WebView must load
 * the page before it can `POST /login`. Mounted session files (media) and the
 * WS upgrade are gated by a per-session token, accepted as a `bare_session`
 * cookie (set via `POST /login` with the one-time bootstrap nonce or the token)
 * or the `X-Bare-Token` header (non-browser clients). The URL `?token=` query
 * param is **not** accepted — a token must never appear in a URL an observer
 * could read. All responses send `Referrer-Policy: no-referrer`.
 */
export function createLoopbackServer(
  options: LoopbackServerOptions = {},
): LoopbackServer {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const authEnabled = options.auth ?? true;
  const wsIdleTimeoutMs = options.wsIdleTimeoutMs ?? 60_000;

  /** URL-safe random secret for the session token / bootstrap nonce. */
  const randomSecret = () =>
    crypto
      .randomBytes(32)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  const fileMounts = new Map<string, string>();
  const dirMounts = new Map<string, string>();
  const publicDirMounts = new Set<string>();
  const routeHandlers = new Map<string, LoopbackRouteHandler>();
  const connectionHandlers: LoopbackConnectionHandler[] = [];
  let token: string | null = options.token ?? null;
  let bootstrapNonce: string | null = null;
  let boundOrigin = '';
  let originPromise: Promise<string> | null = null;
  let activeSocket: WebSocketLike | null = null;

  function isAuthorized(headers: Record<string, string | number>) {
    if (!authEnabled) return true;
    if (token === null) return false;
    if (secretEquals(tokenFromHeaders(headers) ?? '', token)) return true;
    return secretEquals(cookieSession(headers) ?? '', sessionNonce(token));
  }

  /** DNS-rebinding and cross-origin defense for plain HTTP. In auth (device)
   * mode the server never advertises a stable hostname, so a browser request
   * must either carry a same-origin `Origin` header (fetches/subresources) or,
   * for top-level navigations that send no Origin (the initial WebView load),
   * a `Host` header pointing back at the bound 127.0.0.1:port. A DNS-rebinding
   * navigation resolves the loopback address under an attacker-controlled
   * hostname and therefore sends a foreign `Host`. Dev (auth off) is open. */
  function originAllowed(headers: Record<string, string | number>): boolean {
    if (!authEnabled) return true;
    if (boundOrigin === '') return true;
    const boundHostPort = boundOrigin.slice('http://'.length);
    const host = headers['host'];
    if (typeof host !== 'string' || host !== boundHostPort) return false;
    const origin = headers['origin'];
    if (
      typeof origin === 'string' &&
      origin.length > 0 &&
      origin !== boundOrigin
    ) {
      return false;
    }
    return true;
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
    // /login runs before the auth gate, so bound the body a local client can
    // pump at the worklet — an oversized body is a 413, never an OOM DoS.
    void collectRequestBody(req, 4096)
      .then((body) => {
        const trimmed = body.trim();
        const byToken = token !== null && secretEquals(trimmed, token);
        const byBootstrap =
          bootstrapNonce !== null && secretEquals(trimmed, bootstrapNonce);
        const accepted = !authEnabled || byToken || byBootstrap;
        if (!accepted) {
          writeError(res, 401, 'Unauthorized');
          return;
        }
        // A bootstrap nonce is single-use: once the page exchanges it for the
        // session cookie it is spent, so a script that later reads it (or copies
        // it) cannot mint any further requests.
        if (byBootstrap) bootstrapNonce = null;
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
      })
      .catch(() => writeError(res, 413, 'Request Entity Too Large'));
  }

  /** Resolves a request path to a file mount, or a directory mount + relative
   * path. Directory mounts win on longest-prefix match. */
  function resolveMount(
    cleanPath: string,
  ):
    | { kind: 'file'; filePath: string }
    | { kind: 'dir'; dirPath: string; rel: string; public: boolean }
    | null {
    const fileMount = fileMounts.get(cleanPath);
    if (fileMount) return { kind: 'file', filePath: fileMount };
    let best: { dirPath: string; rel: string; public: boolean } | null = null;
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
        best = { dirPath, rel, public: publicDirMounts.has(prefix) };
        bestPrefix = prefix.length;
      }
    }
    return best ? { ...best, kind: 'dir' as const } : null;
  }

  /** Resolves a directory-mount request to a concrete file. Only a `public`
   * (bootstrap) mount applies the SPA fallback (unknown navigation GET →
   * `index.html`); a non-public directory mount 404s unknown paths so
   * unauthenticated clients never receive bootstrap HTML. Subresource requests
   * (`Accept` without `text/html`) never fall back — a missing asset is a 404. */
  function resolveDirFile(
    mount: { kind: 'dir'; dirPath: string; rel: string; public: boolean },
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
    // SPA fallback is scoped to the bootstrap (public) mount only.
    if (!mount.public) return null;
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

  /** Strict Content-Security-Policy for HTML documents served by the loopback
   * server; subresources must stay same-origin (the page talks to the worklet
   * over the loopback socket). `style-src` needs `'unsafe-inline'` for the
   * bundled web app's inline styles and `connect-src` allows the same-origin
   * protocol socket. */
  const CSP_HEADER =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws:";

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
    const contentType = mimeTypeFor(filePath);
    const cspHeader: Record<string, string> =
      contentType === 'text/html'
        ? { 'Content-Security-Policy': CSP_HEADER }
        : {};
    const range = parseRange(req.headers['range'], stat.size);
    if (range) {
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': range.end - range.start + 1,
        'Accept-Ranges': 'bytes',
        ...cspHeader,
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
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      ...cspHeader,
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
      const [rawPath] = requestUrl.split('?');
      // Normalize a trailing slash so `/media/<id>/` still matches the exact
      // file mount (and keeps its auth gate) instead of falling through to the
      // public directory mount.
      const cleanPath = rawPath.split('#')[0].replace(/\/+$/, '') || '/';
      const headers = req.headers as Record<string, string | number>;

      // DNS-rebinding / cross-origin gate: all plain HTTP requests (login,
      // logs, media, static) must target the bound origin in auth mode.
      if (!originAllowed(headers)) {
        writeError(res, 403, 'Forbidden');
        return;
      }

      if (req.method === 'POST' && cleanPath === '/login') {
        handleLogin(req, res);
        return;
      }

      // Never let a path escape a mount root.
      if (cleanPath.split('/').includes('..')) {
        writeError(res, 400, 'Bad request');
        return;
      }

      // Registered routes run before mount resolution, after the auth gate:
      // device mode requires the session cookie/header (dev mode is open).
      const route = routeHandlers.get(`${req.method} ${cleanPath}`);
      if (route) {
        if (!isAuthorized(headers)) {
          writeError(res, 401, 'Unauthorized');
          return;
        }
        try {
          route(req, res);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(res, 500, message);
        }
        return;
      }

      const mount = resolveMount(cleanPath);
      // The bundled web app (directory mounts, e.g. `/`) is public content —
      // a fresh WebView must be able to load the page before `/login` runs.
      // Mounted session files (media) and the WS upgrade stay gated.
      const publicResource =
        mount !== null && mount.kind === 'dir' && mount.public;
      if (!publicResource && !isAuthorized(headers)) {
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
        token ??= randomSecret();
        bootstrapNonce ??= randomSecret();
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
  // 101 so unauthenticated clients never complete a handshake. In auth (device)
  // mode the page is served by this server, so its Origin must match the bound
  // origin exactly — a missing or foreign Origin is rejected outright (no
  // absent-Origin bypass). Dev runs cross-origin (Vite) with auth off, where
  // the check is skipped.
  server.on('upgrade', (req, socket, head) => {
    const headers = req.headers as Record<string, string | number>;

    const origin = headers['origin'];
    const allowed =
      typeof origin === 'string' &&
      origin.length > 0 &&
      origin === boundOrigin &&
      boundOrigin !== '';
    if (authEnabled && !allowed) {
      socket.destroy();
      return;
    }

    if (!isAuthorized(headers)) {
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
        bootstrap: bootstrapNonce!,
      };
    },
    mount(path, filePath) {
      fileMounts.set(path, filePath);
    },
    unmount(path) {
      fileMounts.delete(path);
    },
    mountDir(prefix, dirPath, opts) {
      dirMounts.set(prefix, dirPath);
      if (opts?.public) publicDirMounts.add(prefix);
      else publicDirMounts.delete(prefix);
    },
    onConnection(handler) {
      connectionHandlers.push(handler);
    },
    registerRoute(method, path, handler) {
      routeHandlers.set(`${method.toUpperCase()} ${path}`, handler);
    },
    push(frame) {
      if (!activeSocket) return false;
      try {
        activeSocket.write(frame);
        return true;
      } catch {
        return false;
      }
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
