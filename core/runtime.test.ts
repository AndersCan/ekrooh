import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { HashOptions } from 'node:crypto';
import { createWorkletRuntime, resolveWorkletConfig } from './runtime';

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
      Socket: class {
        on() {}
        destroy() {}
        write() {
          return true;
        }
      },
    },
  };
});

let root: string;
let webDir: string;
let storageDir: string;
let cacheDir: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-test-'));
  webDir = path.join(root, 'web');
  storageDir = path.join(root, 'storage');
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(webDir);
  fs.mkdirSync(storageDir);
  fs.mkdirSync(cacheDir);
  fs.writeFileSync(path.join(webDir, 'index.html'), '<html>app</html>');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveWorkletConfig', () => {
  it('parses the 3-arg host configuration', () => {
    vi.stubGlobal('Bare', { argv: [webDir, storageDir, cacheDir] });
    expect(resolveWorkletConfig()).toEqual({
      webAssets: webDir,
      storage: storageDir,
      cache: cacheDir,
    });
  });

  it('falls back to the storage dir for a 2-arg host (cache not passed)', () => {
    vi.stubGlobal('Bare', { argv: [webDir, storageDir] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveWorkletConfig()).toEqual({
      webAssets: webDir,
      storage: storageDir,
      cache: storageDir,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns {} in dev mode (no host argv)', () => {
    vi.stubGlobal('Bare', undefined);
    expect(resolveWorkletConfig()).toEqual({});
  });
});

describe('createWorkletRuntime', () => {
  it('device mode: binds auth-on, mounts the web app, writes handoff.json', async () => {
    const runtime = createWorkletRuntime({
      webAssets: webDir,
      storage: storageDir,
      cache: cacheDir,
    });
    expect(runtime.config).toEqual({
      webAssets: webDir,
      storage: storageDir,
      cache: cacheDir,
      deviceMode: true,
    });

    const creds = await runtime.start();
    expect(creds.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof creds.token).toBe('string');
    expect(creds.token.length).toBeGreaterThan(0);

    const handoff = JSON.parse(
      fs.readFileSync(path.join(storageDir, 'handoff.json'), 'utf8'),
    );
    expect(handoff).toEqual(creds);

    // The mounted web app is public content; the WS upgrade stays auth-gated.
    const page = await httpGet(`${creds.origin}/`);
    expect(page.status).toBe(200);
    expect(page.body).toBe('<html>app</html>');

    const upgrade = await wsUpgrade(creds.origin, { token: undefined });
    expect(upgrade.split('\r\n')[0]).not.toContain('101');

    runtime.close();
  });

  it('dev mode: auth off, no handoff file', async () => {
    const runtime = createWorkletRuntime({ webAssets: webDir, port: 0 });
    expect(runtime.config.deviceMode).toBe(false);

    const creds = await runtime.start();
    expect(creds.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const page = await httpGet(`${creds.origin}/`);
    expect(page.status).toBe(200);

    // Dev mode has no storage dir, so it never writes a handoff file.
    expect(runtime.config.storage).toBeUndefined();

    // Auth is off in dev: a token-less upgrade succeeds.
    const upgrade = await wsUpgrade(creds.origin, { token: undefined });
    expect(upgrade.split('\r\n')[0]).toContain('101');

    runtime.close();
  });
});

function wsUpgrade(
  origin: string,
  opts: { token?: string } = {},
): Promise<string> {
  const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
  const q = opts.token ? `?token=${opts.token}` : '';
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
          `Origin: ${origin}`,
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

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
