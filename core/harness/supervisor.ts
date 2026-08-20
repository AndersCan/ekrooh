import fs from 'bare-fs';
import path from 'bare-path';
import http from 'bare-http1';
import type {
  HTTPIncomingMessage,
  HTTPStatusCode,
  HTTPServerResponse,
} from 'bare-http1';
import {
  createWorkletRuntime,
  type WorkletRuntime,
  type WorkletRuntimeOptions,
} from '../runtime';
import { createHarnessRegistry, type HarnessRegistry } from './registry';

/**
 * The multi-instance dev/test harness supervisor (ticket #21, design from #5).
 * One Bare process hosts N `createWorkletRuntime` instances (each its own
 * loopback server on an ephemeral port, its own storage/cache dirs, plugins
 * per context) behind a small management HTTP server. A new tab allocates an
 * instance via `POST /instances`, stores the id + origin in `sessionStorage`
 * (new tab = new instance, refresh reuses), and connects to its instance's
 * same-origin WebSocket — Playwright runs multi-user journeys one tab per
 * instance. Instances are reaped after an idle timeout so a long run stays
 * bounded.
 */

export interface HarnessSupervisorOptions {
  /** Directory served at `/` by every instance (the built web app). */
  webAssets: string;
  /** Gitignored base dir; per-instance `storage`/`cache` dirs live under it. */
  baseDir: string;
  host?: string;
  /** Management-server port; `0` picks an ephemeral port (default). */
  port?: number;
  /** Reap instances idle longer than this (ms). Default 5 minutes. */
  idleTimeoutMs?: number;
  /** Extra `createWorkletRuntime` options forwarded per instance. */
  runtimeOptions?: Omit<
    WorkletRuntimeOptions,
    'webAssets' | 'storage' | 'cache'
  >;
}

export interface HarnessSupervisor {
  registry: HarnessRegistry<WorkletRuntime>;
  /** Resolves to the management-server origin. */
  origin(): Promise<string>;
  /** Reaps idle instances now. Returns the reaped ids. */
  reapNow(): Promise<string[]>;
  close(cb?: (err?: Error | null) => void): void;
}

function writeJson(
  res: HTTPServerResponse,
  status: HTTPStatusCode,
  body: Record<string, unknown>,
) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

let nextInstanceId = 1;

export function createHarnessSupervisor(
  options: HarnessSupervisorOptions,
): HarnessSupervisor {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
  const registry = createHarnessRegistry<WorkletRuntime>();
  const origins = new Map<string, string>();

  let originPromise: Promise<string> | null = null;

  function instanceDirs(id: string) {
    const dir = path.join(options.baseDir, id);
    const storage = path.join(dir, 'storage');
    const cache = path.join(dir, 'cache');
    fs.mkdirSync(storage, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    return { dir, storage, cache };
  }

  async function allocate(): Promise<{
    instanceId: string;
    origin: string;
    token: string;
    bootstrap: string;
  }> {
    const id = `inst-${nextInstanceId++}`;
    const { dir, storage, cache } = instanceDirs(id);
    const runtime = createWorkletRuntime({
      webAssets: options.webAssets,
      storage,
      cache,
      host,
      port: 0,
      ...options.runtimeOptions,
    });
    const creds = await runtime.start();
    // Touch on connection traffic AND close so active use postpones the reap
    // (a tab actively used past the idle timeout is never reaped mid-journey).
    runtime.server.onConnection((socket) => {
      const touch = () => registry.touch(id, Date.now());
      touch();
      socket.on('data', touch);
      socket.on('close', touch);
    });
    registry.register({
      id,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      runtime,
      destroy: async () => {
        origins.delete(id);
        await new Promise<void>((resolve) => runtime.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
      },
    });
    origins.set(id, creds.origin);
    return {
      instanceId: id,
      origin: creds.origin,
      token: creds.token,
      bootstrap: creds.bootstrap,
    };
  }

  const server = http.createServer(
    async (req: HTTPIncomingMessage, res: HTTPServerResponse) => {
      try {
        const url = req.url ?? '/';
        const [rawPath] = url.split('?');
        const cleanPath = rawPath.replace(/\/+$/, '') || '/';

        if (req.method === 'GET' && cleanPath === '/health') {
          // Playwright's webServer readiness poll (404 would never satisfy it).
          writeJson(res, 200, { ok: true });
          return;
        }

        if (req.method === 'POST' && cleanPath === '/instances') {
          const allocated = await allocate();
          writeJson(res, 201, allocated);
          return;
        }

        if (req.method === 'GET' && cleanPath === '/instances') {
          writeJson(res, 200, {
            instances: registry.list().map((i) => ({
              instanceId: i.id,
              origin: origins.get(i.id),
              createdAt: i.createdAt,
              lastActiveAt: i.lastActiveAt,
            })),
          });
          return;
        }

        if (req.method === 'DELETE' && cleanPath.startsWith('/instances/')) {
          const id = cleanPath.slice('/instances/'.length);
          if (!registry.get(id)) {
            writeJson(res, 404, { error: 'not found' });
            return;
          }
          await registry.destroy(id);
          writeJson(res, 200, { destroyed: id });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeJson(res, 500, { error: message });
      }
    },
  );

  const reaper = setInterval(() => {
    void registry.reapDue(Date.now(), idleTimeoutMs);
  }, idleTimeoutMs);

  function origin(): Promise<string> {
    if (!originPromise) {
      originPromise = new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve(`http://${host}:${address.port}`);
        });
      });
    }
    return originPromise;
  }

  return {
    registry,
    origin,
    async reapNow() {
      return registry.reapDue(Date.now(), idleTimeoutMs);
    },
    close(cb) {
      clearInterval(reaper);
      void registry
        .reapDue(Date.now(), 0)
        .then(() => server.close(cb))
        .catch((err) => cb?.(err));
    },
  };
}
