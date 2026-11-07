import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { HashOptions } from 'node:crypto';
import { createHarnessSupervisor } from './supervisor';

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
let baseDir: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  webDir = path.join(root, 'web');
  baseDir = path.join(root, 'instances');
  fs.mkdirSync(webDir);
  fs.writeFileSync(path.join(webDir, 'index.html'), '<html>harness</html>');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function jsonRequest(
  url: string,
  method: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createHarnessSupervisor', () => {
  it('refuses browser and DNS-rebinding callers', async () => {
    const sup = createHarnessSupervisor({ webAssets: webDir, baseDir });
    const mgmt = await sup.origin();
    try {
      // A page on another site: credentials must not be readable cross-origin.
      const fromPage = await jsonRequest(`${mgmt}/instances`, 'POST', {
        origin: 'https://evil.example',
      });
      expect(fromPage.status).toBe(403);
      expect(fromPage.body.token).toBeUndefined();
      // A rebinding page reaches the port under its own hostname.
      const rebound = await jsonRequest(`${mgmt}/instances`, 'GET', {
        host: `evil.example:${new URL(mgmt).port}`,
      });
      expect(rebound.status).toBe(403);
      expect(sup.registry.list()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => sup.close(() => resolve()));
    }
  });

  it('refuses a non-loopback bind (it hands out credentials)', () => {
    for (const host of ['0.0.0.0', '192.168.1.2', '::']) {
      expect(() =>
        createHarnessSupervisor({ webAssets: webDir, baseDir, host }),
      ).toThrow(/only a loopback address/);
    }
  });

  it('brackets an IPv6 bind in its origin and accepted Host', async () => {
    let sup: ReturnType<typeof createHarnessSupervisor> | undefined;
    try {
      sup = createHarnessSupervisor({
        webAssets: webDir,
        baseDir,
        host: '::1',
      });
      const mgmt = await sup.origin();
      expect(mgmt).toMatch(/^http:\/\/\[::1\]:\d+$/);
      expect(new URL(mgmt).hostname).toBe('[::1]');
      const health = await jsonRequest(`${mgmt}/health`, 'GET');
      expect(health.status).toBe(200);
    } catch (err) {
      // No IPv6 loopback on this machine: nothing to check.
      if ((err as NodeJS.ErrnoException).code !== 'EADDRNOTAVAIL') throw err;
    } finally {
      const opened = sup;
      await new Promise<void>((resolve) =>
        opened ? opened.close(() => resolve()) : resolve(),
      );
    }
  });

  it('caps live instances with a 429', async () => {
    const sup = createHarnessSupervisor({
      webAssets: webDir,
      baseDir,
      maxInstances: 1,
    });
    const mgmt = await sup.origin();
    try {
      expect((await jsonRequest(`${mgmt}/instances`, 'POST')).status).toBe(201);
      const over = await jsonRequest(`${mgmt}/instances`, 'POST');
      expect(over).toEqual({
        status: 429,
        body: { error: 'too many instances' },
      });
      expect(sup.registry.list()).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => sup.close(() => resolve()));
    }
  });

  it('cleans up a failed allocation and answers a 500 that leaks no detail', async () => {
    // Hold a port so the instance's listen fails after the runtime exists.
    const blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, '127.0.0.1', () => resolve()),
    );
    const busyPort = (blocker.address() as net.AddressInfo).port;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sup = createHarnessSupervisor({
      webAssets: webDir,
      baseDir,
      runtimeOptions: { port: busyPort },
    });
    const mgmt = await sup.origin();
    try {
      const before = new Set(fs.readdirSync(baseDir));
      const failed = await jsonRequest(`${mgmt}/instances`, 'POST');
      expect(failed).toEqual({
        status: 500,
        body: { error: 'internal error' },
      });
      expect(JSON.stringify(failed.body)).not.toContain('EADDRINUSE');
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/^\[harness\] POST \/instances failed: /),
      );
      // No instance dir is left behind and nothing is registered.
      expect(fs.readdirSync(baseDir).filter((d) => !before.has(d))).toEqual([]);
      expect(sup.registry.list()).toEqual([]);
    } finally {
      error.mockRestore();
      await new Promise<void>((resolve) => sup.close(() => resolve()));
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('allocates instances with per-instance dirs and a working web app', async () => {
    const sup = createHarnessSupervisor({
      webAssets: webDir,
      baseDir,
      idleTimeoutMs: 600_000,
    });
    const mgmt = await sup.origin();

    const allocated = await jsonRequest(`${mgmt}/instances`, 'POST');
    expect(allocated.status).toBe(201);
    const { instanceId, origin, token } = allocated.body as {
      instanceId: string;
      origin: string;
      token: string;
    };
    expect(instanceId).toMatch(/^inst-\d+$/);
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    // The instance has its own per-instance storage/cache dirs.
    const dir = path.join(baseDir, instanceId);
    expect(fs.existsSync(path.join(dir, 'storage'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'cache'))).toBe(true);

    // The instance's loopback server serves the web app (public content).
    const page = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${origin}/`,
        { method: 'GET', agent: false },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(page).toBe(200);

    // Management server lists and destroys it.
    const listed = await jsonRequest(`${mgmt}/instances`, 'GET');
    expect(
      (listed.body.instances as Array<{ instanceId: string }>).map(
        (i) => i.instanceId,
      ),
    ).toEqual([instanceId]);

    const deleted = await jsonRequest(
      `${mgmt}/instances/${instanceId}`,
      'DELETE',
    );
    expect(deleted.status).toBe(200);
    const after = await jsonRequest(`${mgmt}/instances`, 'GET');
    expect(after.body.instances).toEqual([]);

    // Destroy tears down the runtime and removes the per-instance dirs.
    expect(fs.existsSync(dir)).toBe(false);

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      sup.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  });

  it('allocates isolated instances with distinct origins', async () => {
    const sup = createHarnessSupervisor({
      webAssets: webDir,
      baseDir,
      idleTimeoutMs: 600_000,
    });
    const mgmt = await sup.origin();

    const a = await jsonRequest(`${mgmt}/instances`, 'POST');
    const b = await jsonRequest(`${mgmt}/instances`, 'POST');
    const originA = (a.body as { origin: string }).origin;
    const originB = (b.body as { origin: string }).origin;
    expect(originA).not.toBe(originB);

    const listed = await jsonRequest(`${mgmt}/instances`, 'GET');
    expect(
      (listed.body.instances as Array<{ instanceId: string }>).length,
    ).toBe(2);

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      sup.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  });

  it('reaps idle instances after the idle timeout', async () => {
    const sup = createHarnessSupervisor({
      webAssets: webDir,
      baseDir,
      idleTimeoutMs: 50,
    });
    const mgmt = await sup.origin();

    const allocated = await jsonRequest(`${mgmt}/instances`, 'POST');
    const { instanceId } = allocated.body as { instanceId: string };
    expect(sup.registry.get(instanceId)).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 120));

    // Idle past the 50ms timeout: the auto-reaper has removed it.
    expect(sup.registry.get(instanceId)).toBeUndefined();

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      sup.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  });

  it('serves a 200 /health readiness probe', async () => {
    const sup = createHarnessSupervisor({
      webAssets: webDir,
      baseDir,
      idleTimeoutMs: 600_000,
    });
    const mgmt = await sup.origin();

    const health = await jsonRequest(`${mgmt}/health`, 'GET');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      sup.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  });
});
