import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { HashOptions } from 'node:crypto';
import {
  BOOTSTRAP_TTL_MAX_MS,
  BOOTSTRAP_TTL_MS,
  BOOTSTRAP_UNLOADED_TTL_MS,
  cookieSession,
  createLoopbackGate,
  secretEquals,
  sessionCookieName,
  sessionNonce,
  tokenFromHeaders,
} from './loopback-gate';

const timingSafeEqual = vi.hoisted(() => ({
  calls: [] as Array<[Uint8Array, Uint8Array]>,
}));

vi.mock('bare-crypto', async () => {
  const crypto = await import('node:crypto');
  return {
    default: {
      ...crypto,
      timingSafeEqual(a: Uint8Array, b: Uint8Array) {
        timingSafeEqual.calls.push([a, b]);
        return crypto.timingSafeEqual(a, b);
      },
      createHash(algorithm: string, options?: HashOptions) {
        if (algorithm === 'blake2b-256') algorithm = 'sha256';
        return crypto.createHash(algorithm, options);
      },
    },
  };
});

const ORIGIN = 'http://127.0.0.1:4000';
const HOST = '127.0.0.1:4000';
const TOKEN = 'test-token';
const COOKIE = `bare_session_4000=${sessionNonce(TOKEN)}`;

function boundGate(
  options: { auth?: boolean; allowedOrigins?: string[] } = {},
) {
  const gate = createLoopbackGate({
    auth: options.auth ?? true,
    token: TOKEN,
    allowedOrigins: options.allowedOrigins,
  });
  gate.bind(ORIGIN);
  return gate;
}

describe('request header helpers', () => {
  it('tokenFromHeaders reads the lowercased header', () => {
    expect(tokenFromHeaders({ 'x-bare-token': 't' })).toBe('t');
    expect(tokenFromHeaders({ authorization: 'nope' })).toBeNull();
  });

  it('cookieSession reads the named cookie from the Cookie header', () => {
    const name = sessionCookieName(4000);
    expect(name).toBe('bare_session_4000');
    expect(cookieSession({ cookie: 'a=1; bare_session_4000=s3' }, name)).toBe(
      's3',
    );
    expect(cookieSession({ cookie: 'bare_session_4000=' }, name)).toBe('');
    expect(cookieSession({ cookie: 'bare_session_4001=s3' }, name)).toBeNull();
    expect(cookieSession({ cookie: 'a=1' }, name)).toBeNull();
    expect(cookieSession({}, name)).toBeNull();
  });

  it('sessionNonce hashes so the raw token never appears in a cookie', () => {
    const nonce = sessionNonce('secret');
    expect(nonce).toBe(sessionNonce('secret'));
    expect(nonce).not.toContain('secret');
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createLoopbackGate', () => {
  it('admits nothing before the server is bound', () => {
    const gate = createLoopbackGate({ auth: false });
    expect(gate.admitRequest({ host: HOST }, 'public')).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('refuses a malformed allowed origin at construction', () => {
    expect(() =>
      createLoopbackGate({ auth: true, allowedOrigins: ['http://a/path'] }),
    ).toThrow(/not a bare origin/);
  });

  describe.each([true, false])('origin rule (auth %s)', (auth) => {
    const gate = boundGate({
      auth,
      allowedOrigins: ['http://localhost:5173'],
    });
    const credential = auth ? { cookie: COOKIE } : {};

    it.each([
      ['the bound host, no Origin (top-level navigation)', { host: HOST }],
      ['the bound origin', { host: HOST, origin: ORIGIN }],
      [
        'the localhost alias',
        { host: 'localhost:4000', origin: 'http://localhost:4000' },
      ],
      [
        'an allowed dev origin',
        { host: HOST, origin: 'http://localhost:5173' },
      ],
    ])('admits %s', (_, headers) => {
      expect(gate.admitRequest({ ...headers, ...credential }, 'gated')).toEqual(
        { ok: true },
      );
    });

    it.each([
      ['a foreign Host (DNS rebinding)', { host: 'evil.example:4000' }],
      ['a missing Host', {}],
      ['the right host on another port', { host: '127.0.0.1:4001' }],
      ['a foreign Origin', { host: HOST, origin: 'http://evil.example' }],
      [
        'a loopback Origin on another port',
        { host: HOST, origin: 'http://localhost:4001' },
      ],
    ])('refuses %s with 403', (_, headers) => {
      expect(
        gate.admitRequest({ ...headers, ...credential }, 'public'),
      ).toMatchObject({ ok: false, status: 403 });
      expect(gate.admitUpgrade({ ...headers, ...credential })).toMatchObject({
        ok: false,
        status: 403,
      });
    });
  });

  it('gates credentials only when auth is on', () => {
    const on = boundGate();
    expect(on.admitRequest({ host: HOST }, 'public')).toEqual({ ok: true });
    expect(on.admitRequest({ host: HOST }, 'gated')).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(
      on.admitRequest({ host: HOST, 'x-bare-token': TOKEN }, 'gated'),
    ).toEqual({ ok: true });
    expect(
      on.admitRequest(
        { host: HOST, cookie: `bare_session_4000=${TOKEN}` },
        'gated',
      ),
    ).toMatchObject({ ok: false, status: 401 });

    const off = boundGate({ auth: false });
    expect(off.admitRequest({ host: HOST }, 'gated')).toEqual({ ok: true });
  });

  it('requires an Origin on an upgrade when auth is on', () => {
    expect(
      boundGate().admitUpgrade({ host: HOST, cookie: COOKIE }),
    ).toMatchObject({ ok: false, status: 403, reason: 'no Origin header' });
    expect(boundGate({ auth: false }).admitUpgrade({ host: HOST })).toEqual({
      ok: true,
    });
  });

  it('explains a refused upgrade credential', () => {
    const gate = boundGate();
    expect(gate.admitUpgrade({ host: HOST, origin: ORIGIN })).toMatchObject({
      status: 401,
      reason: 'unauthorized (no bare_session_4000 cookie)',
    });
    expect(
      gate.admitUpgrade({
        host: HOST,
        origin: ORIGIN,
        cookie: 'bare_session_4000=x',
      }),
    ).toMatchObject({
      status: 401,
      reason: 'unauthorized (cookie present but invalid)',
    });
  });

  it('spends the bootstrap nonce once and answers a replay with 409', () => {
    const gate = boundGate();
    const nonce = gate.bootstrap();
    expect(nonce.length).toBeGreaterThan(0);
    expect(gate.login(nonce, { host: HOST })).toEqual({
      ok: true,
      cookie: `${COOKIE}; HttpOnly; SameSite=Strict; Path=/`,
    });
    expect(gate.bootstrap()).toBe('');
    expect(gate.login(nonce, { host: HOST })).toEqual({
      ok: false,
      status: 409,
    });
    expect(gate.login('nope', { host: HOST })).toEqual({
      ok: false,
      status: 401,
    });
  });

  it('never accepts the raw session token as a login body', () => {
    expect(boundGate().login(TOKEN, { host: HOST })).toEqual({
      ok: false,
      status: 401,
    });
  });

  it('re-logs in a surviving session without spending the nonce', () => {
    const gate = boundGate();
    const nonce = gate.bootstrap();
    expect(gate.login('stale', { host: HOST, cookie: COOKIE }).ok).toBe(true);
    expect(gate.bootstrap()).toBe(nonce);
  });

  it('names the cookie after the bound port so sibling servers keep theirs', () => {
    const other = createLoopbackGate({ auth: true, token: TOKEN });
    other.bind('http://127.0.0.1:4001');
    const login = other.login(other.bootstrap(), { host: '127.0.0.1:4001' });
    expect(login).toMatchObject({
      ok: true,
      cookie: expect.stringMatching(/^bare_session_4001=/),
    });
    // The browser sends both servers' cookies to either port; each server
    // reads only its own.
    const both = `${COOKIE}; bare_session_4001=x`;
    expect(
      boundGate().admitUpgrade({ host: HOST, origin: ORIGIN, cookie: both }),
    ).toEqual({ ok: true });
  });

  it('answers login without a cookie when auth is off', () => {
    expect(boundGate({ auth: false }).login('', { host: HOST })).toEqual({
      ok: true,
      cookie: null,
    });
  });

  it('names the protocol socket of the admitted host for connect-src', () => {
    expect(boundGate().socketSource({ host: 'localhost:4000' })).toBe(
      'ws://localhost:4000',
    );
  });

  describe('cross-site fetch metadata (cookies are not port-scoped)', () => {
    const session = { host: HOST, cookie: COOKIE };

    it.each(['same-site', 'cross-site'])(
      'refuses a credentialed gated request with Sec-Fetch-Site: %s',
      (site) => {
        // A page on 127.0.0.1:<other port> is same-site: its <img> GET carries
        // the Strict cookie and no Origin.
        const headers = { ...session, 'sec-fetch-site': site };
        expect(boundGate().admitRequest(headers, 'gated')).toMatchObject({
          ok: false,
          status: 403,
          reason: `cross-site request (Sec-Fetch-Site: ${site})`,
        });
        expect(
          boundGate().admitUpgrade({ ...headers, origin: ORIGIN }),
        ).toMatchObject({ ok: false, status: 403 });
      },
    );

    it.each([['same-origin'], ['none'], [undefined]])(
      'admits Sec-Fetch-Site: %s',
      (site) => {
        const headers =
          site === undefined ? session : { ...session, 'sec-fetch-site': site };
        expect(boundGate().admitRequest(headers, 'gated')).toEqual({
          ok: true,
        });
        expect(
          boundGate().admitUpgrade({ ...headers, origin: ORIGIN }),
        ).toEqual({ ok: true });
      },
    );

    it('exempts an explicitly allowed origin, never a no-Origin request', () => {
      const gate = boundGate({ allowedOrigins: ['http://localhost:5173'] });
      const listed = {
        host: HOST,
        origin: 'http://localhost:5173',
        'sec-fetch-site': 'cross-site',
        'x-bare-token': TOKEN,
      };
      expect(gate.admitRequest(listed, 'gated')).toEqual({ ok: true });
      expect(
        gate.admitUpgrade({
          ...listed,
          'x-bare-token': undefined,
          cookie: COOKIE,
        }),
      ).toEqual({
        ok: true,
      });
      // The same-site <img> case: no Origin, so no exemption.
      expect(
        gate.admitRequest(
          { host: HOST, cookie: COOKIE, 'sec-fetch-site': 'same-site' },
          'gated',
        ),
      ).toMatchObject({ ok: false, status: 403 });
      // A bound-origin alias is not an explicit entry: no exemption either.
      expect(
        gate.admitRequest(
          {
            host: HOST,
            origin: 'http://localhost:4000',
            cookie: COOKIE,
            'sec-fetch-site': 'same-site',
          },
          'gated',
        ),
      ).toMatchObject({ ok: false, status: 403 });
    });

    it('leaves the public app and dev mode (no credential) alone', () => {
      expect(
        boundGate().admitRequest(
          { host: HOST, 'sec-fetch-site': 'cross-site' },
          'public',
        ),
      ).toEqual({ ok: true });
      // The Vite dev page (localhost:5173) loads backend media cross-site.
      expect(
        boundGate({ auth: false }).admitRequest(
          { host: HOST, 'sec-fetch-site': 'cross-site' },
          'gated',
        ),
      ).toEqual({ ok: true });
    });
  });

  describe('bootstrap nonce lifetime', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const page = { host: HOST, accept: 'text/html' };

    it('expires an unredeemed nonce BOOTSTRAP_TTL_MS after the page load', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const gate = boundGate();
      const nonce = gate.bootstrap();
      gate.admitRequest(page, 'public');
      vi.advanceTimersByTime(BOOTSTRAP_TTL_MS);
      expect(gate.login(nonce, { host: HOST })).toEqual({
        ok: false,
        status: 401,
      });
      expect(gate.bootstrap()).toBe('');
      // A live session still re-logs in after expiry (the reload path).
      expect(gate.login(nonce, { host: HOST, cookie: COOKIE }).ok).toBe(true);
    });

    it('starts the clock at the page load, not at bind (slow cold start)', () => {
      vi.useFakeTimers();
      const gate = boundGate();
      const nonce = gate.bootstrap();
      vi.advanceTimersByTime(BOOTSTRAP_TTL_MS * 2);
      gate.admitRequest(page, 'public');
      vi.advanceTimersByTime(BOOTSTRAP_TTL_MS - 1);
      expect(gate.login(nonce, { host: HOST }).ok).toBe(true);
    });

    it('does not count time spent suspended', () => {
      vi.useFakeTimers();
      const gate = boundGate();
      const nonce = gate.bootstrap();
      gate.admitRequest(page, 'public');
      vi.advanceTimersByTime(1_000);
      // Backgrounded between the page load and /login, for an hour.
      gate.pauseBootstrapClock();
      gate.pauseBootstrapClock();
      vi.advanceTimersByTime(3_600_000);
      gate.resumeBootstrapClock();
      gate.resumeBootstrapClock();
      vi.advanceTimersByTime(BOOTSTRAP_TTL_MS - 1_001);
      expect(gate.login(nonce, { host: HOST }).ok).toBe(true);
    });

    it('still expires after resume once the running time is used up', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const gate = boundGate();
      const nonce = gate.bootstrap();
      gate.admitRequest(page, 'public');
      gate.pauseBootstrapClock();
      vi.advanceTimersByTime(3_600_000);
      gate.resumeBootstrapClock();
      vi.advanceTimersByTime(BOOTSTRAP_TTL_MS);
      expect(gate.login(nonce, { host: HOST }).ok).toBe(false);
    });

    it('expires a nonce whose page never loaded BOOTSTRAP_UNLOADED_TTL_MS after bind', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const gate = boundGate();
      const nonce = gate.bootstrap();
      vi.advanceTimersByTime(BOOTSTRAP_UNLOADED_TTL_MS - 1);
      expect(gate.bootstrap()).toBe(nonce);
      vi.advanceTimersByTime(1);
      expect(gate.bootstrap()).toBe('');
      expect(gate.login(nonce, { host: HOST }).ok).toBe(false);
    });

    it('a late /login is not mistaken for the page load', () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const gate = boundGate();
      const nonce = gate.bootstrap();
      vi.advanceTimersByTime(BOOTSTRAP_UNLOADED_TTL_MS);
      // What the server does for POST /login: admit as public, then login.
      const login = { host: HOST, origin: ORIGIN };
      expect(gate.admitRequest(login, 'public')).toEqual({ ok: true });
      expect(gate.login(nonce, login)).toEqual({ ok: false, status: 401 });
    });

    it('accepts the nonce within a custom lifetime', () => {
      vi.useFakeTimers();
      const gate = createLoopbackGate({
        auth: true,
        token: TOKEN,
        bootstrapTtlMs: 1_000,
      });
      gate.bind(ORIGIN);
      const nonce = gate.bootstrap();
      gate.admitRequest(page, 'public');
      vi.advanceTimersByTime(999);
      expect(gate.login(nonce, { host: HOST }).ok).toBe(true);
    });

    it.each([
      ['NaN', Number.NaN, BOOTSTRAP_TTL_MS],
      ['Infinity', Number.POSITIVE_INFINITY, BOOTSTRAP_TTL_MS],
      ['zero', 0, BOOTSTRAP_TTL_MS],
      ['negative', -5, BOOTSTRAP_TTL_MS],
      ['above the cap', 10 * BOOTSTRAP_TTL_MAX_MS, BOOTSTRAP_TTL_MAX_MS],
    ])('clamps a bootstrapTtlMs that is %s', (_, ttl, effective) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const make = () => {
        const gate = createLoopbackGate({
          auth: true,
          token: TOKEN,
          bootstrapTtlMs: ttl,
        });
        gate.bind(ORIGIN);
        gate.admitRequest(page, 'public');
        return gate;
      };
      const live = make();
      vi.advanceTimersByTime(effective - 1);
      expect(live.bootstrap()).not.toBe('');
      const dead = make();
      vi.advanceTimersByTime(effective);
      expect(dead.bootstrap()).toBe('');
    });
  });

  it('compares every credential through timingSafeEqual', () => {
    // Fails if secretEquals is replaced by ===/!== or skips timingSafeEqual.
    timingSafeEqual.calls.length = 0;
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
    expect(timingSafeEqual.calls).toHaveLength(2);

    const gate = boundGate();
    const nonce = gate.bootstrap();
    timingSafeEqual.calls.length = 0;
    expect(
      gate.admitRequest({ host: HOST, 'x-bare-token': TOKEN }, 'gated'),
    ).toEqual({ ok: true });
    expect(timingSafeEqual.calls.length).toBeGreaterThan(0);
    timingSafeEqual.calls.length = 0;
    expect(gate.admitRequest({ host: HOST, cookie: COOKIE }, 'gated')).toEqual({
      ok: true,
    });
    expect(timingSafeEqual.calls.length).toBeGreaterThan(0);
    timingSafeEqual.calls.length = 0;
    expect(gate.login(nonce, { host: HOST }).ok).toBe(true);
    expect(
      timingSafeEqual.calls.some(
        ([a, b]) =>
          Buffer.from(a).toString() === nonce &&
          Buffer.from(b).toString() === nonce,
      ),
    ).toBe(true);
  });
});
