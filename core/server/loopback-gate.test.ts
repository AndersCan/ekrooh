import { describe, expect, it, vi } from 'vite-plus/test';
import type { HashOptions } from 'node:crypto';
import {
  cookieSession,
  createLoopbackGate,
  sessionNonce,
  tokenFromHeaders,
} from './loopback-gate';

vi.mock('bare-crypto', async () => {
  const crypto = await import('node:crypto');
  return {
    default: {
      ...crypto,
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
const COOKIE = `bare_session=${sessionNonce(TOKEN)}`;

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

  it('cookieSession reads bare_session from the Cookie header', () => {
    expect(cookieSession({ cookie: 'a=1; bare_session=s3' })).toBe('s3');
    expect(cookieSession({ cookie: 'bare_session=' })).toBe('');
    expect(cookieSession({ cookie: 'a=1' })).toBeNull();
    expect(cookieSession({})).toBeNull();
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
      on.admitRequest({ host: HOST, cookie: `bare_session=${TOKEN}` }, 'gated'),
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
      reason: 'unauthorized (no bare_session cookie)',
    });
    expect(
      gate.admitUpgrade({
        host: HOST,
        origin: ORIGIN,
        cookie: 'bare_session=x',
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
});
