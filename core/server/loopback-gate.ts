import crypto from 'bare-crypto';

/** Request headers as the HTTP parser hands them over (names lowercased). */
export type RequestHeaders = Record<
  string,
  string | string[] | number | undefined
>;

/** The gate's answer for one request: let it through, or refuse it with the
 * status the caller writes back and a reason the caller logs. */
export type GateVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 403; reason: string };

/** The answer to a `POST /login` body. `cookie` is the `Set-Cookie` value to
 * send, or null when auth is off. A refused login is a 401 (bad credential) or
 * a 409 (a replay of the bootstrap nonce another document already spent). */
export type LoginVerdict =
  | { ok: true; cookie: string | null }
  | { ok: false; status: 401 | 409 };

export interface LoopbackGateOptions {
  /** Require the session credential. Off only for the dev backend. */
  auth: boolean;
  /** Fixed session token (tests); otherwise a random 32-byte secret. */
  token?: string;
  /** Extra page origins allowed to call the server (e.g. the Vite dev server
   * at `http://localhost:5173`). The bound origin and its loopback aliases are
   * always allowed. Each entry must be a bare `scheme://host[:port]` origin. */
  allowedOrigins?: readonly string[];
  /** How long (ms) after `bind` an unredeemed bootstrap nonce stays valid.
   * Defaults to `BOOTSTRAP_TTL_MS`. */
  bootstrapTtlMs?: number;
}

/** Default lifetime of an unredeemed bootstrap nonce, counted from `bind`. A
 * host reads the handoff and loads the page within moments of the bind, so a
 * nonce still unspent after two minutes is one the page never got: it must not
 * stay a live credential for the whole process lifetime. A reload after that
 * logs in with the surviving session cookie, not the nonce. */
export const BOOTSTRAP_TTL_MS = 120_000;

/**
 * The loopback server's admission policy (ADR 0003), in one place: the session
 * token, the single-use bootstrap nonce, the cookie derived from the token, and
 * the origin rule. The HTTP handler, the WebSocket upgrade and `POST /login`
 * ask it for a verdict and only write the answer.
 *
 * The origin rule holds whether or not auth is on: with auth off (dev) any
 * page open in a browser on the same machine could otherwise drive the
 * backend, since WebSocket upgrades are not subject to CORS and a
 * DNS-rebinding page reaches plain HTTP under a foreign `Host`.
 */
export interface LoopbackGate {
  /** Records the origin the server bound to (`http://<host>:<port>`). Nothing
   * is admitted before this is called. */
  bind(origin: string): void;
  /** The session token, for the host's own `X-Bare-Token` calls. */
  token(): string;
  /** The single-use bootstrap nonce the host injects into the page, or the
   * empty string once it has been spent. */
  bootstrap(): string;
  /** Plain HTTP request. A `public` resource (the bootstrap web app) needs no
   * credential; every request still has to target the bound origin. */
  admitRequest(
    headers: RequestHeaders,
    resource: 'public' | 'gated',
  ): GateVerdict;
  /** WebSocket upgrade: an allowed `Origin` (required when auth is on) and the
   * session credential. */
  admitUpgrade(headers: RequestHeaders): GateVerdict;
  /** Exchanges a `POST /login` body for the session cookie. Accepts the
   * bootstrap nonce once, or an existing session (a reloaded page). */
  login(body: string, headers: RequestHeaders): LoginVerdict;
  /** The `connect-src` source for the protocol socket of a page whose request
   * carried `headers` (already admitted), e.g. `ws://127.0.0.1:49152`. */
  socketSource(headers: RequestHeaders): string;
}

const COOKIE_PREFIX = 'bare_session';
const ORIGIN_PATTERN = /^https?:\/\/[^/?#\s]+$/;

/** `Sec-Fetch-Site` values a credentialed request may carry. Cookies are
 * scoped to the host, not the port (RFC 6265 §8.5), so a page served from
 * another port on `127.0.0.1` is *same-site* with this server: `SameSite=Strict`
 * still attaches the session cookie to its no-`Origin` GETs (`<img>`,
 * `<video>`, navigations). Fetch metadata names that case, so it is refused. A
 * client that sends no `Sec-Fetch-Site` (a non-browser client, an older
 * WebView) is judged by the Host/Origin rule alone. */
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/** Reads the token from the `X-Bare-Token` request header (parser-lowercased).
 * `fetch`-based non-browser clients that cannot carry cookies use this. It
 * travels the cleartext loopback like the cookie, and is only trusted from an
 * allowed origin. */
export function tokenFromHeaders(headers: RequestHeaders): string | null {
  const value = headers['x-bare-token'];
  return typeof value === 'string' ? value : null;
}

/** The session cookie name for a server bound on `port`. Cookies are scoped to
 * the host, not the port, so two loopback servers sharing a browser cookie
 * store (two apps' WebViews, or two desktop backends) would overwrite each
 * other's session under one fixed name. */
export function sessionCookieName(port: string | number): string {
  return `${COOKIE_PREFIX}_${port}`;
}

/** Reads the `name` cookie's value from the `Cookie` request header. */
export function cookieSession(
  headers: RequestHeaders,
  name: string,
): string | null {
  const cookie = headers['cookie'];
  if (typeof cookie !== 'string') return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
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
export function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** URL-safe random secret for the session token / bootstrap nonce. */
function randomSecret(): string {
  return crypto
    .randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** `host:port` forms that name the loopback interface on `port`. `localhost`
 * cannot be pointed elsewhere by a remote DNS answer, so accepting it does not
 * reopen DNS rebinding. */
function loopbackHosts(port: string): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export function createLoopbackGate(options: LoopbackGateOptions): LoopbackGate {
  const { auth } = options;
  for (const origin of options.allowedOrigins ?? []) {
    if (!ORIGIN_PATTERN.test(origin)) {
      throw new Error(
        `allowedOrigins entry is not a bare origin (scheme://host[:port]): '${origin}'`,
      );
    }
  }
  const token = options.token ?? randomSecret();
  const cookieValue = sessionNonce(token);
  const bootstrapTtlMs = options.bootstrapTtlMs ?? BOOTSTRAP_TTL_MS;
  let bootstrapNonce: string | null = randomSecret();
  /** When the nonce stops being accepted; set by `bind`. */
  let bootstrapExpiresAt = Infinity;
  /** The most recently spent bootstrap nonce, kept only to answer replays of
   * it with 409 (valid once but consumed) instead of 401 (bad credential). */
  let spentBootstrapNonce: string | null = null;
  let allowedHosts = new Set<string>();
  let allowedOrigins = new Set<string>();
  let cookieName = COOKIE_PREFIX;

  /** The nonce, or null once it is spent or has expired unredeemed. An expired
   * nonce is dropped for good, so it can never come back to life. */
  function liveNonce(): string | null {
    if (bootstrapNonce !== null && Date.now() >= bootstrapExpiresAt) {
      console.warn(
        `[loopback] bootstrap nonce expired unredeemed after ${bootstrapTtlMs}ms`,
      );
      bootstrapNonce = null;
    }
    return bootstrapNonce;
  }

  /** The cross-port rule (see `ALLOWED_FETCH_SITES`). Only applies with auth
   * on: it protects the session credential, and with auth off (dev) there is
   * none, while the Vite dev page legitimately loads backend media
   * cross-site. */
  function checkFetchSite(headers: RequestHeaders): GateVerdict {
    if (!auth) return { ok: true };
    const site = headers['sec-fetch-site'];
    if (site === undefined || ALLOWED_FETCH_SITES.has(String(site))) {
      return { ok: true };
    }
    return {
      ok: false,
      status: 403,
      reason: `cross-site request (Sec-Fetch-Site: ${String(site)})`,
    };
  }

  function hasCredential(headers: RequestHeaders): boolean {
    if (!auth) return true;
    if (secretEquals(tokenFromHeaders(headers) ?? '', token)) return true;
    return secretEquals(cookieSession(headers, cookieName) ?? '', cookieValue);
  }

  /** The DNS-rebinding and cross-origin rule. `Host` must name the bound
   * server (a rebinding page sends its own hostname). An `Origin`, when sent,
   * must be the bound origin, a loopback alias of it, or an allowed origin.
   * A top-level navigation (the first WebView load) sends no `Origin`. */
  function checkOrigin(
    headers: RequestHeaders,
    requireOrigin: boolean,
  ): GateVerdict {
    if (allowedHosts.size === 0) {
      return { ok: false, status: 403, reason: 'server not bound yet' };
    }
    const host = headers['host'];
    if (typeof host !== 'string' || !allowedHosts.has(host)) {
      return {
        ok: false,
        status: 403,
        reason: `host mismatch (got ${typeof host === 'string' ? `'${host}'` : 'no Host header'})`,
      };
    }
    const origin = headers['origin'];
    if (typeof origin !== 'string' || origin.length === 0) {
      return requireOrigin
        ? { ok: false, status: 403, reason: 'no Origin header' }
        : { ok: true };
    }
    if (!allowedOrigins.has(origin)) {
      return {
        ok: false,
        status: 403,
        reason: `origin mismatch (got '${origin}')`,
      };
    }
    return { ok: true };
  }

  return {
    bind(origin) {
      const hostPort = origin.slice(origin.indexOf('://') + 3);
      const port = hostPort.slice(hostPort.lastIndexOf(':') + 1);
      allowedHosts = new Set([hostPort, ...loopbackHosts(port)]);
      cookieName = sessionCookieName(port);
      bootstrapExpiresAt = Date.now() + bootstrapTtlMs;
      allowedOrigins = new Set([
        origin,
        ...loopbackHosts(port).map((h) => `http://${h}`),
        ...(options.allowedOrigins ?? []),
      ]);
    },
    token: () => token,
    bootstrap: () => liveNonce() ?? '',
    admitRequest(headers, resource) {
      const origin = checkOrigin(headers, false);
      if (!origin.ok) return origin;
      if (resource === 'public') return { ok: true };
      const site = checkFetchSite(headers);
      if (!site.ok) return site;
      if (!hasCredential(headers)) {
        return { ok: false, status: 401, reason: 'unauthorized' };
      }
      return { ok: true };
    },
    admitUpgrade(headers) {
      // A browser always sends `Origin` on an upgrade, so with auth on a
      // missing one is refused outright. Dev also admits non-browser clients.
      const origin = checkOrigin(headers, auth);
      if (!origin.ok) return origin;
      const site = checkFetchSite(headers);
      if (!site.ok) return site;
      if (!hasCredential(headers)) {
        return {
          ok: false,
          status: 401,
          reason: `unauthorized (${headers['cookie'] ? 'cookie present but invalid' : `no ${cookieName} cookie`})`,
        };
      }
      return { ok: true };
    },
    login(body, headers) {
      // Dev mode (auth off) has no credential to check and sets no cookie,
      // but still answers so the page transport proceeds.
      if (!auth) return { ok: true, cookie: null };
      const credential = body.trim();
      const nonce = liveNonce();
      const byBootstrap = nonce !== null && secretEquals(credential, nonce);
      // A reloaded page re-runs the shell with the same, now spent, nonce, but
      // its session cookie survives the reload. Accepting the session keeps
      // "reload reconnects" working; a replayed spent nonce alone still fails.
      const bySession = hasCredential(headers);
      if (!byBootstrap && !bySession) {
        // A replay of the spent nonce means another document logged in first
        // with the nonce this one was also given. 409 tells the shell to retry
        // once instead of giving up; it grants nothing.
        const spent =
          spentBootstrapNonce !== null &&
          secretEquals(credential, spentBootstrapNonce);
        return { ok: false, status: spent ? 409 : 401 };
      }
      if (byBootstrap) {
        spentBootstrapNonce = nonce;
        bootstrapNonce = null;
      }
      return {
        ok: true,
        cookie: `${cookieName}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/`,
      };
    },
    socketSource(headers) {
      const host = headers['host'];
      return `ws://${typeof host === 'string' ? host : ''}`;
    },
  };
}
