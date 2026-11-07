import fs from 'bare-fs';
import http from 'bare-http1';
import type {
  HTTPIncomingMessage,
  HTTPServerResponse,
  HTTPStatusCode,
} from 'bare-http1';
import path from 'bare-path';
import { TextDecoder, TextEncoder } from 'bare-encoding';
import { createLoopbackGate } from './loopback-gate';
import {
  createProtocolSocketSlot,
  type LoopbackConnectionHandler,
} from './protocol-socket';

export type {
  LoopbackConnectionHandler,
  LoopbackRequest,
  WebSocketLike,
} from './protocol-socket';

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

/** A file opened for serving: its real path, an open descriptor and the
 * `fstat` of that descriptor. The bytes are streamed from `fd`, never by
 * re-opening `filePath`, so what was checked is what is sent. Whoever takes a
 * `ResolvedFile` owns `fd` and must stream it or `closeSync` it. */
type ResolvedFile = {
  filePath: string;
  fd: number;
  stat: ReturnType<typeof fs.fstatSync>;
};

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Already closed or never valid: nothing left to release.
  }
}

/** Opens `realPath` (already resolved by `realpathSync` and checked to lie in
 * its mount) and proves the descriptor is that file. A path component swapped
 * for a symlink between the check and the open would make the open land
 * elsewhere, so after opening the real path must still resolve to itself and
 * its `lstat` must be the opened inode. Returns null (descriptor closed) when
 * anything moved, or when it is not a regular file. */
function openVerified(realPath: string): ResolvedFile | null {
  let fd: number;
  try {
    fd = fs.openSync(realPath, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      closeQuietly(fd);
      return null;
    }
    if (fs.realpathSync(realPath) !== realPath) {
      console.warn(
        `[static-server] refused a file that moved while it was opened: ${realPath}`,
      );
      closeQuietly(fd);
      return null;
    }
    const link = fs.lstatSync(realPath);
    if (!link.isFile() || link.ino !== stat.ino || link.dev !== stat.dev) {
      console.warn(
        `[static-server] refused a file that moved while it was opened: ${realPath}`,
      );
      closeQuietly(fd);
      return null;
    }
    return { filePath: realPath, fd, stat };
  } catch {
    closeQuietly(fd);
    return null;
  }
}

/** A path in the form mount roots are compared in: its real path when it
 * exists (a root may be missing at mount time), lowercased and NFC-normalized
 * because the default APFS volume on macOS and iOS ignores case and
 * normalization. Folding can only make two roots compare as overlapping more
 * often, which errs toward refusing a layout, never toward serving. */
function comparableRoot(dirPath: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(dirPath);
  } catch {
    resolved = path.resolve(dirPath);
  }
  return resolved.normalize('NFC').toLowerCase();
}

/** The longest Origin/Host value echoed into a log line. */
const MAX_LOGGED_REASON_CHARS = 200;
/** Upgrade rejections logged per window; the rest are counted and reported
 * once when the window ends. Any website can trigger a rejected upgrade, so
 * without a limit one could evict every real diagnostic from the log ring. */
const UPGRADE_REJECTION_LOG_LIMIT = 10;
const UPGRADE_REJECTION_LOG_WINDOW_MS = 10_000;

/** Rate limiter for upgrade-rejection log lines. Each window logs up to
 * `limit` lines; the first rejection of a later window first reports how
 * many were suppressed in the one before it. */
export function createRejectionLogger(
  log: (line: string) => void,
  options: { limit?: number; windowMs?: number; now?: () => number } = {},
): (reason: string) => void {
  const limit = options.limit ?? UPGRADE_REJECTION_LOG_LIMIT;
  const windowMs = options.windowMs ?? UPGRADE_REJECTION_LOG_WINDOW_MS;
  const now = options.now ?? Date.now;
  let windowStart = -Infinity;
  let logged = 0;
  let suppressed = 0;
  return (reason) => {
    const t = now();
    if (t - windowStart >= windowMs) {
      if (suppressed > 0) {
        log(
          `[loopback] upgrade rejected: ${suppressed} more rejections suppressed`,
        );
      }
      windowStart = t;
      logged = 0;
      suppressed = 0;
    }
    if (logged >= limit) {
      suppressed++;
      return;
    }
    logged++;
    const text =
      reason.length > MAX_LOGGED_REASON_CHARS
        ? `${reason.slice(0, MAX_LOGGED_REASON_CHARS)}…`
        : reason;
    log(`[loopback] upgrade rejected: ${text}`);
  };
}

/** How a response may be cached by the WebView:
 * - `immutable`: content-addressed bundle, safe to keep for a year;
 * - `revalidate`: bootstrap content, reusable only after an ETag check;
 * - `no-store`: session-gated or replaceable files (e.g. mounted media). */
export type CachePolicy = 'immutable' | 'revalidate' | 'no-store';

/** Files under `assets/` whose name ends in an 8-character content hash before
 * the extension (the Vite/Rolldown default, e.g. `assets/main-DkY3x9qZ.js`)
 * are treated as content-addressed. Anything else — including `index.html` —
 * must be revalidated. */
const HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

export function cachePolicyFor(
  rel: string,
  mountIsPublic: boolean,
): CachePolicy {
  if (!mountIsPublic) return 'no-store';
  return HASHED_ASSET.test(rel) ? 'immutable' : 'revalidate';
}

/** Weak validator from size and mtime. Weak because the same bytes can be
 * re-written with a new mtime, which only costs one extra full response. */
export function etagFor(stat: { size: number; mtimeMs: number }): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/** Whether an `If-None-Match` header (a list of validators, or `*`) matches. */
export function etagMatches(
  header: string | string[] | number | undefined,
  etag: string,
): boolean {
  if (typeof header !== 'string') return false;
  return header
    .split(',')
    .some((candidate) => candidate.trim() === etag || candidate.trim() === '*');
}

/** Parses a `Range: bytes=<start>-<end>` header. Returns `null` when absent or
 * unsatisfiable (caller falls back to a 200 full response). */
export function parseRange(
  value: string | string[] | number | undefined,
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
    let byteCount = 0;
    let exceeded = false;
    req.on('data', (chunk: unknown) => {
      // `maxBytes` is a BYTE cap (anti-OOM DoS guard) — `body.length` counts
      // UTF-16 code units, so multi-byte UTF-8 would slide ~3× under it.
      // Once the cap is breached we stop retaining chunks: discarding the rest
      // bounds memory instead of buffering an arbitrarily large body.
      if (exceeded) return;
      const str =
        typeof chunk === 'string'
          ? chunk
          : decoder.decode(chunk as Uint8Array, { stream: true });
      body += str;
      byteCount +=
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk).byteLength
          : (chunk as Uint8Array).byteLength;
      if (byteCount > maxBytes) {
        exceeded = true;
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (exceeded) return; // already rejected on the oversize chunk
      const final = body + decoder.decode(new Uint8Array(0));
      if (byteCount > maxBytes) {
        reject(new Error('Request body too large'));
        return;
      }
      resolve(final);
    });
  });
}

/** Handler for a registered HTTP route on the loopback server. An async
 * handler that rejects is answered with a bare 500, like a throwing one. The
 * return type stays `void`: an async function already fits it, while
 * `void | Promise<void>` would reject the common `(req, res) => res.end()`. */
export type LoopbackRouteHandler = (
  req: HTTPIncomingMessage,
  res: HTTPServerResponse,
) => void;

export interface LoopbackServerOptions {
  /** Bind address. Defaults to `127.0.0.1`. A non-loopback address throws
   * unless `auth` is on. */
  host?: string;
  /** Port to bind; `0` picks an ephemeral port (on-device). */
  port?: number;
  /** Require the per-session token/cookie on every gated request and WS
   * upgrade. Defaults to on; only the dev backend turns it off. The origin
   * check applies either way. */
  auth?: boolean;
  /** Fixed session token (tests); otherwise a random 32-byte token. */
  token?: string;
  /** Extra page origins allowed to call the server, e.g. the Vite dev server
   * (`http://localhost:5173`). The bound origin and its loopback aliases
   * (`127.0.0.1`, `localhost`, `[::1]` on the bound port) are always allowed. */
  allowedOrigins?: readonly string[];
  /** Idle timeout (ms) after which an authenticated WebSocket connection is
   * dropped. Defaults to 60s. */
  wsIdleTimeoutMs?: number;
  /** Dead-peer timeout for the protocol socket, in ms. The socket sends a
   * protocol-level ping at half this interval and is destroyed when nothing (a
   * pong included) arrives within it, so a suspended or reloaded WebView frees
   * the slot in seconds. Browsers answer pings themselves, so this needs no
   * application message. Defaults to 10s. */
  wsDeadPeerTimeoutMs?: number;
  /** Minimum gap, in ms, between an accepted protocol socket and the next one
   * that may replace it; an upgrade that arrives sooner is held until then.
   * Bounds eviction churn if two live clients compete. Defaults to 1000. */
  wsReplaceMinIntervalMs?: number;
  /** Most bytes queued behind a protocol socket whose reader has stopped reading
   * before server pushes are dropped, newest first. Responses are queued past
   * this (to 8x) and then the socket is closed rather than lose one. Defaults to
   * 2 MiB. */
  wsMaxQueuedBytes?: number;
  /** How long the bootstrap nonce stays redeemable after binding, in ms.
   * Defaults to the gate's `BOOTSTRAP_TTL_MS`. */
  bootstrapTtlMs?: number;
}

export interface LoopbackServer {
  /** Resolves to the server origin (`http://127.0.0.1:<port>`), binding on
   * first use. */
  origin(): Promise<string>;
  /** Resolves to a URL for `path` (`<origin><path>`). The per-session cookie
   * authorizes media loads; no token is embedded in the URL. */
  url(path: string): Promise<string>;
  /** The per-session token. The host reads it from `credentials()` for its own
   * `X-Bare-Token` calls and never injects it into the page. */
  token(): string;
  /** Resolves to the bound origin, port, token and the one-time bootstrap
   * nonce (empty once spent). The host injects `bootstrap` into the page (not
   * the token); the page exchanges it once via `POST /login` for the HttpOnly
   * session cookie. */
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
   * The SPA fallback to `dirPath/index.html` for unknown navigation GETs
   * applies only to `public` mounts (the bootstrap web app). Pass
   * `{ public: true }` to mark a mount as world-readable bootstrap content
   * served before auth; a non-public directory mount gates every request
   * behind the session. A request never resolves outside `dirPath`, symlinks
   * included. Throws when a public and a gated mount's directories contain
   * one another. */
  mountDir(prefix: string, dirPath: string, opts?: { public?: boolean }): void;
  /** Registers a handler for authenticated, handshaken WebSocket connections
   * (the protocol socket). */
  onConnection(handler: LoopbackConnectionHandler): void;
  /** Registers an HTTP route. `handler` runs before mount resolution, after
   * the auth gate (device mode requires the session cookie/token). `path` is
   * normalized like a mount path (decoded, trailing slash dropped). The
   * response starts with `Referrer-Policy`, `X-Content-Type-Options` (and
   * `Cross-Origin-Resource-Policy` unless extra `allowedOrigins` are configured)
   * already set; a handler that
   * throws or rejects is answered with a bare 500. Read the body with
   * `collectRequestBody`, passing a byte cap. */
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

/** Splits a request target into its decoded path segments, or null when the
 * path cannot name a file inside a mount: a malformed escape, or a segment
 * that is `.`/`..` or carries a separator or NUL once decoded (`%2e%2e`,
 * `%2f`, `\`). Empty segments (`//`, a trailing `/`) are dropped. */
export function pathSegments(target: string): string[] | null {
  const rawPath = target.split(/[?#]/, 1)[0];
  const segments: string[] = [];
  for (const raw of rawPath.split('/')) {
    if (raw === '') continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

/** The key a mount path is stored under: the same decoded, normalized form a
 * request path is matched in, so `/media/a%20b` and `/media/a b/` name one
 * mount. A path no request could ever match is a programming error. */
function mountKey(mountPath: string): string {
  const segments = pathSegments(mountPath);
  if (segments === null) {
    throw new Error(`invalid mount path: '${mountPath}'`);
  }
  return `/${segments.join('/')}`;
}

/** Whether a bind address names the loopback interface only. */
export function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** Whether `candidate` is `root` or lies below it. Both must be absolute,
 * normalized paths. */
function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/**
 * The single loopback HTTP+WS server for the worklet. One origin serves the
 * web app (`/`), the media files mounted by plugins, and the framed-protocol
 * WebSocket socket the page connects to. On device it binds `127.0.0.1` on an
 * ephemeral port. Admission (origin rule, session credential, bootstrap login)
 * is decided by the loopback gate (`loopback-gate.ts`); the protocol socket's
 * lifecycle by the protocol socket slot (`protocol-socket.ts`). All responses
 * send `Referrer-Policy: no-referrer`.
 */
export function createLoopbackServer(
  options: LoopbackServerOptions = {},
): LoopbackServer {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const auth = options.auth ?? true;
  // The Host/Origin rule only stops browsers; a client on another machine
  // sends whatever `Host` it likes. Without a credential, a non-loopback bind
  // hands every plugin to the network.
  if (!auth && !isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind '${host}' with auth off: only a loopback address may serve without a credential`,
    );
  }
  // An IPv6 literal is bracketed in a URL (`http://[::1]:port`) but not when
  // binding.
  const bindHost = host.replace(/^\[(.*)\]$/, '$1');
  const originHost = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  const gate = createLoopbackGate({
    auth,
    token: options.token,
    allowedOrigins: options.allowedOrigins,
    bootstrapTtlMs: options.bootstrapTtlMs,
  });
  const slot = createProtocolSocketSlot({
    idleTimeoutMs: options.wsIdleTimeoutMs ?? 60_000,
    deadPeerTimeoutMs: options.wsDeadPeerTimeoutMs ?? 10_000,
    replaceMinIntervalMs: options.wsReplaceMinIntervalMs ?? 1_000,
    maxQueuedBytes: options.wsMaxQueuedBytes ?? 2 * 1024 * 1024,
  });

  const fileMounts = new Map<string, string>();
  const dirMounts = new Map<string, string>();
  const publicDirMounts = new Set<string>();
  const routeHandlers = new Map<string, LoopbackRouteHandler>();
  let originPromise: Promise<string> | null = null;
  const logUpgradeRejection = createRejectionLogger((line) =>
    console.error(line),
  );

  /** `Cross-Origin-Resource-Policy: same-origin` stops another site embedding
   * a response (`<img>`, `<script>`) even if a credential rode along. It is
   * left off when extra page origins are allowed: the Vite dev page lives on
   * another origin and loads backend media cross-site. */
  const resourcePolicy: Record<string, string> =
    (options.allowedOrigins ?? []).length === 0
      ? { 'Cross-Origin-Resource-Policy': 'same-origin' }
      : {};

  /** Headers every framework-built response carries. */
  const BASE_HEADERS: Record<string, string> = {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };

  function writeError(
    res: HTTPServerResponse,
    status: HTTPStatusCode,
    message: string,
    extra: Record<string, string> = {},
  ) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, {
      'Content-Type': 'text/plain',
      ...BASE_HEADERS,
      ...resourcePolicy,
      ...extra,
    });
    res.end(message);
  }

  /** Logs the cause and answers a bare 500: an exception message can carry
   * file paths or plugin internals, which never belong in a response body. */
  function writeInternalError(
    res: HTTPServerResponse,
    context: string,
    err: unknown,
  ) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[loopback] ${context} failed: ${message}`);
    writeError(res, 500, 'Internal Server Error');
  }

  function handleLogin(req: HTTPIncomingMessage, res: HTTPServerResponse) {
    // /login runs before the credential check, so bound the body a local
    // client can pump at the worklet: an oversized body is a 413, never an
    // OOM.
    collectRequestBody(req, 4096)
      .then(
        (body) => {
          const verdict = gate.login(body, req.headers);
          if (!verdict.ok) {
            writeError(res, verdict.status, 'Unauthorized');
            return;
          }
          const headers: Record<string, string> = {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
            ...BASE_HEADERS,
            ...resourcePolicy,
          };
          if (verdict.cookie !== null) headers['Set-Cookie'] = verdict.cookie;
          res.writeHead(200, headers);
          res.end('ok');
        },
        () => {
          // Answer, then drop the connection: the rest of an oversized
          // pre-auth body is never read off the socket.
          res.on('finish', () => req.destroy());
          writeError(res, 413, 'Request Entity Too Large', {
            Connection: 'close',
          });
        },
      )
      .catch((err: unknown) => writeInternalError(res, 'POST /login', err));
  }

  /** Resolves a request path to a file mount, or a directory mount + the path
   * segments below it. Directory mounts win on longest-prefix match. */
  function resolveMount(
    cleanPath: string,
    segments: string[],
  ):
    | { kind: 'file'; filePath: string }
    | { kind: 'dir'; dirPath: string; rel: string[]; public: boolean }
    | null {
    const fileMount = fileMounts.get(cleanPath);
    if (fileMount) return { kind: 'file', filePath: fileMount };
    let best: { dirPath: string; rel: string[]; public: boolean } | null = null;
    let bestDepth = -1;
    for (const [prefix, dirPath] of dirMounts) {
      const prefixSegments = prefix.split('/').filter((s) => s !== '');
      const depth = prefixSegments.length;
      if (depth <= bestDepth) continue;
      if (!prefixSegments.every((s, i) => segments[i] === s)) continue;
      best = {
        dirPath,
        rel: segments.slice(depth),
        public: publicDirMounts.has(prefix),
      };
      bestDepth = depth;
    }
    return best ? { ...best, kind: 'dir' as const } : null;
  }

  /** Resolves a directory-mount request to a concrete file inside the mount
   * root (its real path, so a symlink cannot lead outside it). Only a
   * `public` (bootstrap) mount applies the SPA fallback (unknown navigation
   * GET → `index.html`); a non-public directory mount 404s unknown paths so
   * unauthenticated clients never receive bootstrap HTML. Subresource requests
   * (`Accept` without `text/html`) never fall back — a missing asset is a
   * 404. */
  function resolveDirFile(
    mount: { dirPath: string; rel: string[]; public: boolean },
    headers: Record<string, string | string[] | number | undefined>,
  ): (ResolvedFile & { rel: string }) | null {
    let root: string;
    try {
      root = fs.realpathSync(mount.dirPath);
    } catch {
      console.debug(
        `[static-server] mount root ${mount.dirPath} is missing — 404`,
      );
      return null;
    }
    const served = (file: ResolvedFile | null) => {
      if (file === null) return null;
      if (mount.public && insideGatedMount(file.filePath)) {
        console.warn(
          `[static-server] refused a gated file through the public mount: ${file.filePath}`,
        );
        closeQuietly(file.fd);
        return null;
      }
      return {
        ...file,
        rel: path.relative(root, file.filePath).split(path.sep).join('/'),
      };
    };
    if (mount.rel.length > 0) {
      const found = served(fileWithin(root, path.join(root, ...mount.rel)));
      if (found) return found;
      // SPA fallback is scoped to the bootstrap (public) mount and to
      // navigations (browsers send `Accept: text/html` on top-level GETs).
      if (!mount.public) return null;
      const accept = headers['accept'];
      if (typeof accept !== 'string' || !accept.includes('text/html')) {
        return null;
      }
    }
    return served(fileWithin(root, path.join(root, 'index.html')));
  }

  /** Whether a real path lies in a gated directory mount's root. The public
   * mount refuses such a file even if the layout
   * check in `mountDir` was sidestepped (a root that became a symlink into
   * the web app after it was mounted, a case alias on a case-insensitive
   * volume). */
  function insideGatedMount(realPath: string): boolean {
    const candidate = realPath.normalize('NFC').toLowerCase();
    for (const [key, dirPath] of dirMounts) {
      if (publicDirMounts.has(key)) continue;
      if (isWithin(comparableRoot(dirPath), candidate)) return true;
    }
    return false;
  }

  /** `candidate` opened for serving when it exists, is a regular file, and
   * its real path stays inside `root`. A missing file is routine (every SPA
   * route, every missing asset), so it is not logged. */
  function fileWithin(root: string, candidate: string): ResolvedFile | null {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      return null;
    }
    if (!isWithin(root, real)) {
      console.warn(
        `[static-server] refused a path that resolves outside its mount: ${candidate}`,
      );
      return null;
    }
    return openVerified(real);
  }

  /** Strict Content-Security-Policy for HTML documents served by the loopback
   * server. Subresources stay same-origin; `connect-src` names the one
   * protocol socket the page may open (`ws:` alone would allow any host).
   * `style-src` needs `'unsafe-inline'` for the bundled web app's inline
   * styles. */
  function cspFor(socketSource: string): string {
    return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${socketSource}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  }

  /** Policy for mounted session files (media). They are loaded by `<img>` and
   * `<video>`, where a response CSP has no effect; it only bites when one is
   * opened as a document, so a hostile file (an SVG with script) runs in an
   * opaque, script-less sandbox instead of the app origin. */
  const MOUNTED_FILE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; sandbox";

  function serveFile(
    req: HTTPIncomingMessage,
    res: HTTPServerResponse,
    file: ResolvedFile,
    cache: CachePolicy = 'no-store',
    sandboxed = false,
  ) {
    const { filePath, fd, stat } = file;
    const contentType = mimeTypeFor(filePath);
    const policyHeaders: Record<string, string> = {
      ...BASE_HEADERS,
      ...(sandboxed
        ? { 'Content-Security-Policy': MOUNTED_FILE_CSP, ...resourcePolicy }
        : contentType === 'text/html'
          ? {
              'Content-Security-Policy': cspFor(gate.socketSource(req.headers)),
            }
          : {}),
    };
    const range = parseRange(req.headers['range'], stat.size);
    if (range) {
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': range.end - range.start + 1,
        'Accept-Ranges': 'bytes',
        ...policyHeaders,
        'Cache-Control': 'no-store',
      });
      // Flush the headers immediately so bare-http1 does not append its own
      // (zero) Content-Length when the piped stream ends.
      res.flushHeaders();
      pipeFile(res, file, range);
      return;
    }
    const cacheHeaders: Record<string, string> =
      cache === 'no-store'
        ? { 'Cache-Control': 'no-store' }
        : {
            'Cache-Control':
              cache === 'immutable'
                ? 'max-age=31536000, immutable'
                : 'no-cache',
            ETag: etagFor(stat),
          };
    if (
      cache !== 'no-store' &&
      etagMatches(req.headers['if-none-match'], cacheHeaders.ETag)
    ) {
      closeQuietly(fd);
      res.writeHead(304, {
        ...cacheHeaders,
        ...BASE_HEADERS,
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      ...policyHeaders,
      ...cacheHeaders,
    });
    res.flushHeaders();
    pipeFile(res, file);
  }

  /** Streams an opened file's bytes to the response from its descriptor (the
   * stream closes it), with an error handler: a read error must never become
   * an unhandled `'error'` that crashes the whole worklet. Headers are flushed
   * before piping, so a mid-stream error aborts the response rather than
   * writing a late status. */
  function pipeFile(
    res: HTTPServerResponse,
    file: ResolvedFile,
    range?: { start: number; end: number },
  ) {
    const stream = fs.createReadStream(
      file.filePath,
      range
        ? { fd: file.fd, start: range.start, end: range.end }
        : { fd: file.fd },
    );
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

  /** Opens a file mount's target. The host chose the path, so it is not
   * confined to a root, but it is still served from a verified descriptor so a
   * file evicted (or swapped) after the lookup is a 404, not a crash. */
  function openFileMount(filePath: string): ResolvedFile | null {
    let real: string;
    try {
      real = fs.realpathSync(filePath);
    } catch {
      return null;
    }
    return openVerified(real);
  }

  function runRoute(
    route: LoopbackRouteHandler,
    req: HTTPIncomingMessage,
    res: HTTPServerResponse,
    label: string,
  ) {
    // Set before the handler runs so a consumer route carries them unless it
    // overrides them on purpose.
    for (const [name, value] of Object.entries({
      ...BASE_HEADERS,
      ...resourcePolicy,
    })) {
      res.setHeader(name, value);
    }
    let result: unknown;
    try {
      result = route(req, res);
    } catch (err) {
      writeInternalError(res, label, err);
      return;
    }
    // An async handler that rejects would otherwise be an unhandled
    // rejection, which aborts the Bare process, and leave the client hanging.
    if (
      result instanceof Promise ||
      (typeof result === 'object' &&
        result !== null &&
        typeof (result as PromiseLike<unknown>).then === 'function')
    ) {
      (result as PromiseLike<unknown>).then(undefined, (err: unknown) =>
        writeInternalError(res, label, err),
      );
    }
  }

  function handleRequest(req: HTTPIncomingMessage, res: HTTPServerResponse) {
    const headers = req.headers;
    const segments = pathSegments(req.url ?? '/');
    if (segments === null) {
      writeError(res, 400, 'Bad request');
      return;
    }
    const cleanPath = `/${segments.join('/')}`;

    if (req.method === 'POST' && cleanPath === '/login') {
      // The origin rule still applies; the credential is the body.
      const verdict = gate.admitRequest(headers, 'public');
      if (!verdict.ok) {
        writeError(res, verdict.status, 'Forbidden');
        return;
      }
      handleLogin(req, res);
      return;
    }

    // Registered routes run before mount resolution and are always gated.
    const route = routeHandlers.get(`${req.method} ${cleanPath}`);
    if (route) {
      const verdict = gate.admitRequest(headers, 'gated');
      if (!verdict.ok) {
        writeError(
          res,
          verdict.status,
          verdict.status === 401 ? 'Unauthorized' : 'Forbidden',
        );
        return;
      }
      runRoute(route, req, res, `route ${req.method} ${cleanPath}`);
      return;
    }

    const mount = resolveMount(cleanPath, segments);
    // Only the bootstrap web app (a `public` directory mount) is served before
    // `/login`; mounted session files (media) stay gated.
    const verdict = gate.admitRequest(
      headers,
      mount !== null && mount.kind === 'dir' && mount.public
        ? 'public'
        : 'gated',
    );
    if (!verdict.ok) {
      writeError(
        res,
        verdict.status,
        verdict.status === 401 ? 'Unauthorized' : 'Forbidden',
      );
      return;
    }

    if (mount === null) {
      writeError(res, 404, 'Not found');
      return;
    }
    if (mount.kind === 'file') {
      const file = openFileMount(mount.filePath);
      if (file === null) {
        console.debug(
          `[static-server] file mount target ${mount.filePath} is unreadable — 404`,
        );
        writeError(res, 404, 'Not found');
        return;
      }
      // Mounted files (e.g. media) can be replaced under the same URL and
      // are session-gated: never cacheable.
      serveFile(req, res, file, 'no-store', true);
      return;
    }
    const resolved = resolveDirFile(mount, headers);
    if (resolved === null) {
      writeError(res, 404, 'Not found');
      return;
    }
    // Policy is decided from the file actually served, so an SPA fallback to
    // `index.html` is revalidated rather than mistaken for a hashed asset.
    // Only the bootstrap mount is app code. A gated directory mount holds
    // content (user files, peer-synced folders), so it gets the same sandbox
    // as a file mount: HTML or SVG in it must never run in the app origin.
    serveFile(
      req,
      res,
      resolved,
      cachePolicyFor(resolved.rel, mount.public),
      !mount.public,
    );
  }

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      writeInternalError(res, `${req.method} request`, err);
    }
  });

  function origin(): Promise<string> {
    if (!originPromise) {
      originPromise = new Promise<string>((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, bindHost, () => {
          const address = server.address();
          const bound = `http://${originHost}:${address?.port}`;
          gate.bind(bound);
          resolve(bound);
        });
      });
    }
    return originPromise;
  }

  // WS upgrade: the gate decides before the handshake, so an unadmitted
  // client never receives a 101. Every rejection is logged with a stable
  // `[loopback] upgrade rejected:` prefix, and answered with its HTTP status
  // where there is one — a silent `socket.destroy()` is indistinguishable on
  // the client from "server unreachable". These lines are captured by the
  // `core.logs` ring buffer, so they are rate limited and the echoed header
  // values truncated (`createRejectionLogger`): any website can trigger one.
  server.on('upgrade', (req, socket, head) => {
    const reject = (reason: string, status?: 401 | 403 | 429) => {
      logUpgradeRejection(reason);
      if (status === undefined) {
        socket.destroy();
        return;
      }
      // The socket is half-open by default: close it once the answer is out
      // rather than wait on the peer to hang up.
      socket.on('finish', () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.end(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n` +
          'Connection: close\r\nContent-Length: 0\r\n' +
          'Referrer-Policy: no-referrer\r\n\r\n',
      );
    };
    const verdict = gate.admitUpgrade(req.headers);
    if (!verdict.ok) {
      reject(verdict.reason, verdict.status);
      return;
    }
    slot.accept(req, socket, head, reject);
  });

  async function url(path: string): Promise<string> {
    return `${await origin()}${path}`;
  }

  return {
    origin,
    url,
    token: () => gate.token(),
    async credentials() {
      const originUrl = await origin();
      return {
        origin: originUrl,
        port: Number(originUrl.slice(originUrl.lastIndexOf(':') + 1)),
        token: gate.token(),
        bootstrap: gate.bootstrap(),
      };
    },
    mount(path, filePath) {
      fileMounts.set(mountKey(path), filePath);
    },
    unmount(path) {
      fileMounts.delete(mountKey(path));
    },
    mountDir(prefix, dirPath, opts) {
      const key = mountKey(prefix);
      const isPublic = opts?.public === true;
      // A public root that contains a gated one (or sits inside it) would
      // serve the gated files before login, as app code, under another URL
      // (`/peer/x` for a `/shared` mount at `<web>/peer`, or `/Shared/x` on a
      // case-insensitive volume). Refuse the layout outright.
      const root = comparableRoot(dirPath);
      for (const [otherKey, otherPath] of dirMounts) {
        if (otherKey === key) continue;
        if (publicDirMounts.has(otherKey) === isPublic) continue;
        const other = comparableRoot(otherPath);
        if (isWithin(root, other) || isWithin(other, root)) {
          throw new Error(
            `mountDir('${prefix}'): '${dirPath}' overlaps the ${isPublic ? 'gated' : 'public'} mount '${otherKey}' at '${otherPath}'; a public and a gated directory mount must not contain each other`,
          );
        }
      }
      dirMounts.set(key, dirPath);
      if (isPublic) publicDirMounts.add(key);
      else publicDirMounts.delete(key);
    },
    onConnection: (handler) => slot.onConnection(handler),
    registerRoute(method, path, handler) {
      // Keyed in the same decoded, normalized form a request path is matched
      // in, so `/api/` and `/a%20b` are reachable.
      routeHandlers.set(`${method.toUpperCase()} ${mountKey(path)}`, handler);
    },
    push: (frame) => slot.push(frame),
    close(cb) {
      slot.close();
      server.close(cb);
    },
  };
}
