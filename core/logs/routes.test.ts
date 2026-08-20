import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import http from 'node:http';
import type { HashOptions } from 'node:crypto';
import { createLoopbackServer } from '../server/static-file-server';
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
});
