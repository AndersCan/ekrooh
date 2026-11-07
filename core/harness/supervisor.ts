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
import { isLoopbackHost } from '../server/static-file-server';
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
  /** Bind address of the management server and every instance. Must be a
   * loopback address: the management API hands out instance credentials to
   * whoever asks, so it never listens on the network. Defaults to
   * `127.0.0.1`. */
  host?: string;
  /** Management-server port; `0` picks an ephemeral port (default). */
  port?: number;
  /** Reap instances idle longer than this (ms). Default 5 minutes. */
  idleTimeoutMs?: number;
  /** Most instances alive (or being started) at once; `POST /instances` past
   * it answers 429. Defaults to `DEFAULT_MAX_INSTANCES`. */
  maxInstances?: number;
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

/** Default cap on live harness instances: each holds a loopback server and two
 * dirs, and any local process may ask for one. */
export const DEFAULT_MAX_INSTANCES = 32;

/** `host:port` with an IPv6 literal bracketed, as a `Host` header and a URL
 * spell it. */
function hostPort(host: string, port: number | undefined): string {
  const literal =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${literal}:${port}`;
}

function writeJson(
  res: HTTPServerResponse,
  status: HTTPStatusCode,
  body: Record<string, unknown>,
) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The management API hands out instance credentials, so only a local
 * non-browser client (the Playwright runner) may call it: a browser request
 * carries `Origin`, and a DNS-rebinding page carries a foreign `Host`. */
function isTrustedCaller(
  headers: HTTPIncomingMessage['headers'],
  boundHosts: ReadonlySet<string>,
): boolean {
  const host = headers['host'];
  return (
    headers['origin'] === undefined &&
    typeof host === 'string' &&
    boundHosts.has(host)
  );
}

let nextInstanceId = 1;

export function createHarnessSupervisor(
  options: HarnessSupervisorOptions,
): HarnessSupervisor {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind the harness supervisor to '${host}': it hands out instance credentials, so only a loopback address may serve it`,
    );
  }
  const port = options.port ?? 0;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
  const maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES;
  /** Allocations past the cap check whose instance is not registered yet. */
  let starting = 0;
  const registry = createHarnessRegistry<WorkletRuntime>();
  const origins = new Map<string, string>();

  let originPromise: Promise<string> | null = null;
  let boundHosts = new Set<string>();

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
    let runtime: WorkletRuntime | null = null;
    let creds: Awaited<ReturnType<WorkletRuntime['start']>>;
    try {
      runtime = createWorkletRuntime({
        webAssets: options.webAssets,
        storage,
        cache,
        host,
        port: 0,
        ...options.runtimeOptions,
      });
      creds = await runtime.start();
    } catch (err) {
      // A half-started instance must not keep its server, port or dirs.
      const failed = runtime;
      if (failed) {
        await new Promise<void>((resolve) => failed.close(() => resolve()));
      }
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    const started = runtime;
    // Touch on connection traffic AND close so active use postpones the reap
    // (a tab actively used past the idle timeout is never reaped mid-journey).
    started.server.onConnection((socket) => {
      const touch = () => registry.touch(id, Date.now());
      touch();
      socket.on('data', touch);
      socket.on('close', touch);
    });
    registry.register({
      id,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      runtime: started,
      destroy: async () => {
        origins.delete(id);
        await new Promise<void>((resolve) => started.close(() => resolve()));
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
        if (!isTrustedCaller(req.headers, boundHosts)) {
          writeJson(res, 403, { error: 'forbidden' });
          return;
        }
        const url = req.url ?? '/';
        const [rawPath] = url.split('?');
        const cleanPath = rawPath.replace(/\/+$/, '') || '/';

        if (req.method === 'GET' && cleanPath === '/health') {
          // Playwright's webServer readiness poll (404 would never satisfy it).
          writeJson(res, 200, { ok: true });
          return;
        }

        if (req.method === 'POST' && cleanPath === '/instances') {
          if (registry.list().length + starting >= maxInstances) {
            writeJson(res, 429, { error: 'too many instances' });
            return;
          }
          starting++;
          let allocated: Awaited<ReturnType<typeof allocate>>;
          try {
            allocated = await allocate();
          } finally {
            starting--;
          }
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
        // The cause is logged, never echoed: it can carry file paths.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[harness] ${req.method} ${req.url} failed: ${message}`);
        writeJson(res, 500, { error: 'internal error' });
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
          const bound = address?.port;
          boundHosts = new Set([
            hostPort(host, bound),
            `127.0.0.1:${bound}`,
            `localhost:${bound}`,
            `[::1]:${bound}`,
          ]);
          resolve(`http://${hostPort(host, bound)}`);
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
