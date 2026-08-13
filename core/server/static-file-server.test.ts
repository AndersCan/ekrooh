import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { HashOptions } from 'node:crypto';
import type { HTTPIncomingMessage } from 'bare-http1';
import {
  collectRequestBody,
  cookieSession,
  createLoopbackServer,
  mimeTypeFor,
  parseRange,
  sessionNonce,
  tokenFromHeaders,
  tokenFromQuery,
} from './static-file-server';

vi.mock('bare-http1', async () => ({
  default: (await import('node:http')).default,
}));
vi.mock('bare-fs', async () => ({
  default: (await import('node:fs')).default,
}));
vi.mock('bare-path', async () => ({
  default: (await import('node:path')).default,
}));
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
vi.mock('bare-ws', async () => {
  const crypto = await import('node:crypto');
  return {
    default: {
      Server: {
        handshake(
          req: http.IncomingMessage,
          socket: net.Socket,
          _head: Buffer,
          cb: (err?: unknown) => void,
        ) {
          const key = String(req.headers['sec-websocket-key'] ?? '');
          const accept = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          socket.write(
            [
              'HTTP/1.1 101 Switching Protocols',
              'Upgrade: websocket',
              'Connection: Upgrade',
              `Sec-WebSocket-Accept: ${accept}`,
              '\r\n',
            ].join('\r\n'),
          );
          cb(null);
        },
      },
      Socket: class extends EventEmitter {
        private socket?: net.Socket;
        constructor(opts?: { socket?: net.Socket }) {
          super();
          this.socket = opts?.socket;
          // The real ws library closes the client when the TCP socket dies;
          // mirror that so the server's `client.on('close')` (activeSocket
          // cleanup) actually fires when a test destroys its connection.
          this.socket?.on('close', () => this.emit('close'));
          // A client reset (destroy) surfaces an ECONNRESET read error on the
          // server-side socket; swallow it here rather than leaking an uncaught
          // error into the test runner.
          this.socket?.on('error', () => {});
        }
        destroy() {
          this.socket?.destroy();
          this.emit('close');
        }
        write(data: unknown) {
          // Forward to the underlying TCP socket so a server `push` reaches the
          // test client (the real ws.Socket writes through to the TCP socket).
          if (this.socket) {
            return this.socket.write(data as Buffer);
          }
          return true;
        }
      },
    },
  };
});

const TOKEN = 'test-token';
let dir: string;
let origin = '';
let port = 0;
let cookie = '';
let server: ReturnType<typeof createLoopbackServer> | null = null;
let devServer: ReturnType<typeof createLoopbackServer> | null = null;

function request(
  urlPath: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${origin}${urlPath}`,
      { method: opts.method ?? 'GET', agent: false },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    for (const [k, v] of Object.entries(opts.headers ?? {}))
      req.setHeader(k, v);
    req.end(opts.body ?? undefined);
  });
}

function firstHeader(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | null {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return null;
}

function rawRequest(lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = (v: string) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.write([...lines, '\r\n'].join('\r\n'));
      setTimeout(() => {
        socket.destroy();
        finish(data);
      }, 3000);
    });
    socket.on('data', (d) => {
      data += String(d);
      if (data.includes('\r\n')) finish(data);
    });
    socket.on('close', () => finish(data));
    socket.on('error', () => finish(data));
  });
}

function upgradeRequest(
  opts: {
    token?: string;
    origin?: string;
  } = {},
): Promise<string> {
  const q = opts.token ? `?token=${opts.token}` : '';
  const originHeader = opts.origin ?? origin;
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = (v: string) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.write(
        [
          `GET /ws${q} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `Origin: ${originHeader}`,
          '\r\n',
        ].join('\r\n'),
      );
      setTimeout(() => {
        socket.destroy();
        finish(data);
      }, 3000);
    });
    socket.on('data', (d) => {
      data += String(d);
      if (data.includes('\r\n')) {
        socket.destroy();
        finish(data);
      }
    });
    socket.on('close', () => finish(data));
    socket.on('error', () => finish(data));
  });
}

/** Opens a WebSocket upgrade and KEEPS the socket open, resolving once the
 * server's response line arrives. The caller owns the returned socket. */
function openUpgrade(
  opts: {
    token?: string;
    origin?: string;
    port?: number;
  } = {},
): Promise<{ socket: net.Socket; response: string }> {
  const targetPort = opts.port ?? port;
  const originHeader = opts.origin ?? origin;
  const q = opts.token ? `?token=${opts.token}` : '';
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: targetPort });
    let data = '';
    let settled = false;
    const finish = (response: string) => {
      if (!settled) {
        settled = true;
        resolve({ socket, response });
      }
    };
    socket.on('connect', () => {
      socket.write(
        [
          `GET /ws${q} HTTP/1.1`,
          `Host: 127.0.0.1:${targetPort}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `Origin: ${originHeader}`,
          '\r\n',
        ].join('\r\n'),
      );
    });
    socket.on('data', (d) => {
      data += String(d);
      if (data.includes('\r\n')) finish(data);
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error('connection closed before the upgrade response'));
      }
    });
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-test-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>index</html>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("app")');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'main.js'), 'export const x = 1');

  server = createLoopbackServer({ auth: true, token: TOKEN });
  server.mountDir('/', dir);
  server.mount('/media/sample.png', path.join(dir, 'app.js'));
  server.onConnection((socket) => {
    socket.on('data', (raw) => socket.write(raw));
  });

  const creds = await server.credentials();
  origin = creds.origin;
  port = creds.port;

  const login = await request('/login', {
    method: 'POST',
    body: TOKEN,
  });
  cookie = `${firstHeader(login.headers, 'set-cookie')?.split(';')[0] ?? ''}`;

  devServer = createLoopbackServer({ auth: false, port: 0 });
  devServer.mountDir('/', dir);
  await devServer.credentials();
});

afterAll(async () => {
  const closeWithTimeout = (
    s: ReturnType<typeof createLoopbackServer> | null,
  ) =>
    new Promise<void>((resolve) => {
      if (!s) return resolve();
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      s.close(() => done());
      setTimeout(done, 2000);
    });
  await closeWithTimeout(server);
  await closeWithTimeout(devServer);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pure request helpers', () => {
  it('mimeTypeFor maps known extensions and defaults otherwise', () => {
    expect(mimeTypeFor('a.js')).toBe('text/javascript');
    expect(mimeTypeFor('b.css')).toBe('text/css');
    expect(mimeTypeFor('c.unknown')).toBe('application/octet-stream');
  });

  it('tokenFromQuery finds the token param', () => {
    expect(tokenFromQuery('a=1&token=x&b=2')).toBe('x');
    expect(tokenFromQuery('token=')).toBe('');
    expect(tokenFromQuery('a=1')).toBeNull();
  });

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

  it('parseRange handles full, open-ended, suffix and overlong ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('garbage', 100)).toBeNull();
    expect(parseRange('bytes=10-20', 100)).toEqual({ start: 10, end: 20 });
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=-5', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=10-500', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=100-200', 100)).toBeNull();
    expect(parseRange('bytes=10-9', 100)).toBeNull();
  });
});

describe('loopback server HTTP', () => {
  it('serves the public web app before auth', async () => {
    const r = await request('/');
    expect(r.status).toBe(200);
    expect(r.body).toBe('<html>index</html>');
  });

  it('gates file mounts without credentials', async () => {
    const r = await request('/media/sample.png');
    expect(r.status).toBe(401);
  });

  it('logs in with the token and sets a hardened cookie', async () => {
    const r = await request('/login', { method: 'POST', body: TOKEN });
    expect(r.status).toBe(200);
    const setCookie = firstHeader(r.headers, 'set-cookie');
    expect(setCookie).toMatch(/^bare_session=/);
    expect(setCookie!).toContain('HttpOnly');
    expect(setCookie!).toContain('SameSite=Lax');
  });

  it('rejects a bad login', async () => {
    const r = await request('/login', { method: 'POST', body: 'nope' });
    expect(r.status).toBe(401);
  });

  it('serves media with the session cookie', async () => {
    const r = await request('/media/sample.png', {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('console.log("app")');
  });

  it('accepts the query token fallback on protected mounts', async () => {
    const r = await request(`/media/sample.png?token=${TOKEN}`);
    expect(r.status).toBe(200);
  });

  it('accepts the X-Bare-Token header fallback', async () => {
    const r = await request('/media/sample.png', {
      headers: { 'X-Bare-Token': TOKEN },
    });
    expect(r.status).toBe(200);
  });

  it('rejects path traversal with a raw request', async () => {
    const raw = await rawRequest([
      'GET /../etc/passwd HTTP/1.1',
      'Host: 127.0.0.1',
      'Connection: close',
    ]);
    expect(raw.split('\r\n')[0]).toContain('400');
  });

  it('falls back to index.html for unknown navigation paths', async () => {
    const r = await request('/some/route', {
      headers: { cookie, accept: 'text/html,application/xhtml+xml' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('<html>index</html>');
  });

  it('404s a missing subresource instead of SPA-falling back', async () => {
    const r = await request('/assets/missing.js', { headers: { cookie } });
    expect(r.status).toBe(404);
  });

  it('serves byte ranges with Content-Range', async () => {
    const r = await request('/app.js', {
      headers: { cookie, range: 'bytes=0-3' },
    });
    expect(r.status).toBe(206);
    expect(r.body).toBe('cons');
    expect(r.headers['content-range']).toBeDefined();
  });

  it('clamps overlong ranges to the file size', async () => {
    const r = await request('/app.js', {
      headers: { cookie, range: 'bytes=2-500' },
    });
    expect(r.status).toBe(206);
    expect(r.body.length).toBe('console.log("app")'.length - 2);
  });

  it('sets the content type from the extension', async () => {
    const r = await request('/app.js', { headers: { cookie } });
    expect(r.headers['content-type']).toBe('text/javascript');
    const r2 = await request('/assets/main.js', { headers: { cookie } });
    expect(r2.headers['content-type']).toBe('text/javascript');
  });

  it('always sends Referrer-Policy: no-referrer', async () => {
    const r = await request('/app.js', { headers: { cookie } });
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('handles a read-stream error without crashing the worklet (evicted file)', async () => {
    const bareFs = (await import('bare-fs')) as unknown as {
      default: typeof fs;
    };
    const erroring = new PassThrough();
    const spy = vi
      .spyOn(bareFs.default, 'createReadStream')
      .mockImplementation(() => {
        process.nextTick(() =>
          erroring.destroy(
            Object.assign(new Error('bad file descriptor'), { code: 'EBADF' }),
          ),
        );
        return erroring as never;
      });
    try {
      // Headers are flushed before the pipe, so the error aborts the response
      // (the client sees a reset, never a hang or a crashed worklet). The
      // request is fire-and-forget — it may settle as a reset or a hang.
      void request('/app.js', { headers: { cookie } }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      spy.mockRestore();
    }
    // The worklet is still alive: a normal request succeeds afterwards.
    const ok = await request('/app.js', { headers: { cookie } });
    expect(ok.status).toBe(200);
  });

  it('mount/unmount removes a file mount and re-serves after re-mount', async () => {
    server!.mount('/media/transient.txt', path.join(dir, 'app.js'));
    const served = await request('/media/transient.txt', {
      headers: { cookie },
    });
    expect(served.status).toBe(200);

    server!.unmount('/media/transient.txt');
    const gone = await request('/media/transient.txt', {
      headers: { cookie },
    });
    expect(gone.status).toBe(404);
    // After unmount the path falls through to the public `/` dir mount, so it
    // is public content and 404s regardless of auth.
    const unauthed = await request('/media/transient.txt');
    expect(unauthed.status).toBe(404);

    server!.mount('/media/transient.txt', path.join(dir, 'app.js'));
    const back = await request('/media/transient.txt', {
      headers: { cookie },
    });
    expect(back.status).toBe(200);
  });
});

describe('loopback server WebSocket upgrade', () => {
  it('handshakes with the query token', async () => {
    const raw = await upgradeRequest({ token: TOKEN });
    expect(raw.split('\r\n')[0]).toContain('101');
    expect(raw).toContain('Sec-WebSocket-Accept:');
  });

  it('rejects an upgrade without credentials', async () => {
    const raw = await upgradeRequest();
    expect(raw.split('\r\n')[0]).not.toContain('101');
  });

  it('rejects a cross-origin upgrade when auth is on', async () => {
    const raw = await upgradeRequest({
      token: TOKEN,
      origin: 'http://evil.example',
    });
    expect(raw.split('\r\n')[0]).not.toContain('101');
  });

  it('rejects a second socket while one is active (single-client policy)', async () => {
    const sc = createLoopbackServer({ auth: true, token: TOKEN });
    sc.mountDir('/', dir);
    const creds = await sc.credentials();
    const scPort = Number(
      creds.origin.slice(creds.origin.lastIndexOf(':') + 1),
    );
    const base = { token: TOKEN, origin: creds.origin, port: scPort };

    const first = await openUpgrade(base);
    expect(first.response.split('\r\n')[0]).toContain('101');

    // Rejected before the handshake: the second connection closes without a
    // 101 response (never looks like an established connection).
    await expect(openUpgrade(base)).rejects.toThrow(
      /closed before the upgrade response/,
    );

    first.socket.destroy();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      sc.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  it('destroys an idle authenticated socket after the idle timeout', async () => {
    const idleServer = createLoopbackServer({
      auth: true,
      token: TOKEN,
      wsIdleTimeoutMs: 120,
    });
    idleServer.mountDir('/', dir);
    const creds = await idleServer.credentials();
    const idlePort = Number(
      creds.origin.slice(creds.origin.lastIndexOf(':') + 1),
    );

    const conn = await openUpgrade({
      token: TOKEN,
      origin: creds.origin,
      port: idlePort,
    });
    expect(conn.response.split('\r\n')[0]).toContain('101');

    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      conn.socket.on('close', done);
      conn.socket.on('end', done);
    });
    expect(closed).toBe(true);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      idleServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  it('registerRoute serves a custom endpoint behind the auth gate', async () => {
    const sc = createLoopbackServer({ auth: true, token: TOKEN });
    sc.registerRoute('POST', '/upload', async (req, res) => {
      const body = await collectRequestBody(req);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: body }));
    });
    const creds = await sc.credentials();

    const post = (urlPath: string, body: string, token?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const headers: Record<string, string> = {
          'Content-Type': 'text/plain',
        };
        if (token) headers['X-Bare-Token'] = token;
        const req = http.request(
          `${creds.origin}${urlPath}`,
          { method: 'POST', headers, agent: false },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body: data }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      });

    // Authenticated → 201 with the echoed body.
    const authed = await post('/upload', 'hello-worklet', TOKEN);
    expect(authed.status).toBe(201);
    expect(authed.body).toBe(JSON.stringify({ received: 'hello-worklet' }));

    // No credentials → 401 (device mode gates custom routes too).
    const denied = await post('/upload', 'hello-worklet');
    expect(denied.status).toBe(401);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      sc.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  it('push writes a raw frame to the connected protocol socket', async () => {
    const sc = createLoopbackServer({ auth: true, token: TOKEN });
    sc.mountDir('/', dir);
    const creds = await sc.credentials();
    const scPort = Number(
      creds.origin.slice(creds.origin.lastIndexOf(':') + 1),
    );
    const base = { token: TOKEN, origin: creds.origin, port: scPort };

    const conn = await openUpgrade(base);
    expect(conn.response.split('\r\n')[0]).toContain('101');

    const frame = new TextEncoder().encode('{"push":true}');
    expect(sc.push(frame)).toBe(true);

    // No socket → push reports false (nothing connected).
    conn.socket.removeAllListeners('data');
    conn.socket.on('error', () => {});
    conn.socket.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(sc.push(frame)).toBe(false);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      sc.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
});

describe('dev mode (auth off)', () => {
  it('serves public content and answers login without a cookie', async () => {
    const devServerInstance = devServer!;
    const pageUrl = await devServerInstance.url('/');

    const get = (url: string) =>
      new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const req = http.request(
          url,
          { method: 'GET', agent: false },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      });

    const r = await get(pageUrl);
    expect(r.status).toBe(200);
    expect(r.body).toBe('<html>index</html>');

    const loginUrl = await devServerInstance.url('/login');
    const login = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = http.request(
        loginUrl,
        { method: 'POST', agent: false },
        (res) => {
          res.on('data', () => {});
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(login.status).toBe(200);
    expect(firstHeader(login.headers, 'set-cookie')).toBeNull();
  });

  it('accepts a cross-origin upgrade (the Vite dev server case)', async () => {
    const devOrigin = await devServer!.origin();
    const devPort = Number(devOrigin.slice(devOrigin.lastIndexOf(':') + 1));
    const raw = await new Promise<string>((resolve) => {
      let data = '';
      let done = false;
      const finish = (v: string) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      const socket = net.connect({ host: '127.0.0.1', port: devPort });
      socket.on('connect', () =>
        socket.write(
          [
            'GET /ws HTTP/1.1',
            `Host: 127.0.0.1:${devPort}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            'Origin: http://localhost:5173',
            '\r\n',
          ].join('\r\n'),
        ),
      );
      socket.on('data', (d) => {
        data += String(d);
        if (data.includes('\r\n')) {
          socket.destroy();
          finish(data);
        }
      });
      socket.on('close', () => finish(data));
      socket.on('error', () => finish(data));
      setTimeout(() => {
        socket.destroy();
        finish(data);
      }, 3000);
    });
    expect(raw.split('\r\n')[0]).toContain('101');
  });
});

describe('collectRequestBody (/login body decoding)', () => {
  it('decodes a Uint8Array body as UTF-8 (bare-http1 chunks)', async () => {
    const req = new EventEmitter() as unknown as HTTPIncomingMessage;
    const pending = collectRequestBody(req);
    req.emit('data', new Uint8Array([116, 111, 107, 101, 110]));
    req.emit('end');
    await expect(pending).resolves.toBe('token');
  });

  it('concatenates split chunks across a stream boundary', async () => {
    const req = new EventEmitter() as unknown as HTTPIncomingMessage;
    const pending = collectRequestBody(req);
    req.emit('data', new Uint8Array([116, 111]));
    req.emit('data', new Uint8Array([107, 101, 110]));
    req.emit('end');
    await expect(pending).resolves.toBe('token');
  });

  it('keeps multi-byte characters intact across chunk boundaries', async () => {
    const req = new EventEmitter() as unknown as HTTPIncomingMessage;
    const pending = collectRequestBody(req);
    req.emit('data', new Uint8Array([0x74, 0x6f, 0x6b, 0xc3]));
    req.emit('data', new Uint8Array([0xa9, 0x6e]));
    req.emit('end');
    await expect(pending).resolves.toBe('tokén');
  });
});
