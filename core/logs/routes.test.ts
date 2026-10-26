import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import type { HashOptions } from 'node:crypto';
import {
  createLoopbackServer,
  type LoopbackServer,
} from '../server/static-file-server';
import { registerLogRoutes } from './routes';
import { createLogRingBuffer } from './store';
import type { LogStore } from './types';

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
vi.mock('bare-ws', async () => ({
  default: {
    Server: {
      handshake() {},
    },
    Socket: class {
      on() {}
      destroy() {}
      write() {
        return true;
      }
    },
  },
}));

let origin = '';
let server: ReturnType<typeof createLoopbackServer> | null = null;
let store: LogStore;

function request(
  urlPath: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${origin}${urlPath}`,
      { method: opts.method ?? 'GET', agent: false },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    for (const [k, v] of Object.entries(opts.headers ?? {}))
      req.setHeader(k, v);
    req.end(opts.body ?? undefined);
  });
}

beforeAll(async () => {
  store = createLogRingBuffer(100);
  server = createLoopbackServer({ auth: false, port: 0 });
  registerLogRoutes(server, store);
  const creds = await server.credentials();
  origin = creds.origin;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    server.close(() => done());
    setTimeout(done, 2000);
  });
});

describe('registerLogRoutes', () => {
  it('POST /logs ingests a web batch and GET /logs reads it back as text', async () => {
    const post = await request('/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'web',
        entries: [
          { level: 'info', message: 'booted' },
          { level: 'warn', tag: 'sync', message: 'retry' },
        ],
      }),
    });
    expect(post.status).toBe(200);
    expect(JSON.parse(post.body)).toEqual({ accepted: 2 });

    const get = await request('/logs');
    expect(get.status).toBe(200);
    expect(get.body).toContain('INFO web booted');
    expect(get.body).toContain('WARN web [sync] retry');
  });

  it('GET /logs?format=jsonl returns NDJSON', async () => {
    const res = await request('/logs?format=jsonl');
    expect(res.status).toBe(200);
    const lines = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      level: 'info',
      source: 'web',
      message: 'booted',
    });
    expect(lines[1]).toMatchObject({ tag: 'sync', source: 'web' });
  });

  it('GET /logs supports tail, level and source filters', async () => {
    const res = await request('/logs?tail=1&level=warn&source=web');
    expect(res.status).toBe(200);
    expect(res.body).toContain('WARN web [sync] retry');
    expect(res.body).not.toContain('booted');
  });

  it('ingest defaults source to web and rejects unparseable bodies', async () => {
    store.clear();
    const post = await request('/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ message: 'no-source' }] }),
    });
    expect(JSON.parse(post.body)).toEqual({ accepted: 1 });
    const view = store.view();
    expect(view[0]?.source).toBe('web');

    const bad = await request('/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
  });

  it('answers a non-object body with 400 and records page entries as web', async () => {
    store.clear();
    for (const body of ['null', '42', '"text"']) {
      const r = await request('/logs', { method: 'POST', body });
      expect(r.status).toBe(400);
    }
    const spoof = await request('/logs', {
      method: 'POST',
      body: JSON.stringify({
        source: 'backend',
        entries: [{ message: 'fake', level: 'fatal', tag: 7 }, null, 5],
      }),
    });
    expect(JSON.parse(spoof.body)).toEqual({ accepted: 1 });
    expect(store.view()[0]).toMatchObject({
      source: 'web',
      level: 'info',
      tag: undefined,
      message: 'fake',
    });
  });

  it('answers a malformed GET /logs query with 400', async () => {
    const r = await request('/logs?tail=%E0%A4%A');
    expect(r.status).toBe(400);
  });

  it('refuses an oversized /logs body over a real socket and ingests nothing', async () => {
    store.clear();
    const big = JSON.stringify({
      source: 'web',
      entries: [{ message: 'x'.repeat(2 * 1024 * 1024) }],
    });
    // The server answers 413 while the client is still writing and then closes
    // the connection. Whether the client sees that 413 or a reset first is a
    // TCP race (the reset can discard the unread response), so either outcome
    // is a refusal. The exact 413 is asserted without a socket just below.
    const outcome = await request('/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: big,
    }).then(
      (res) => res.status,
      (err: NodeJS.ErrnoException) => err.code,
    );
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(outcome);
    // The oversized batch must not have been ingested.
    expect(store.view().length).toBe(0);
  });

  it('answers an oversized /logs body with 413 and ingests nothing (no socket)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const routes = new Map<string, (req: unknown, res: unknown) => void>();
      const ownStore = createLogRingBuffer(10);
      registerLogRoutes(
        {
          registerRoute: (method: string, path: string, handler: never) => {
            routes.set(`${method} ${path}`, handler);
          },
        } as unknown as LoopbackServer,
        ownStore,
      );

      const req = new PassThrough();
      const responded = new Promise<{ status: number; body: string }>(
        (resolve) => {
          let status = 0;
          routes.get('POST /logs')!(req, {
            writeHead(code: number) {
              status = code;
            },
            end(body: string) {
              resolve({ status, body });
            },
          });
        },
      );
      req.write(
        JSON.stringify({
          source: 'web',
          entries: [{ message: 'x'.repeat(2 * 1024 * 1024) }],
        }),
      );
      req.end();

      const res = await responded;
      expect(res.status).toBe(413);
      expect(res.body).toBe('Request Entity Too Large');
      expect(ownStore.view()).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
