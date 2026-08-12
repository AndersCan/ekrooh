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
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false }, (res) => {
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
});
