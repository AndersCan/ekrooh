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
import {
  createWorkletRuntime,
  resolveCliConfig,
  resolveWorkletConfig,
} from './runtime';
import { EventEmitter } from 'node:events';
import { definePlugin, MessageProtocol, MessageType, ok } from './messages';
import type { EventSpec } from './messages';
import { createLoopbackServer } from './server/static-file-server';

// Record the options each runtime hands its loopback server (the real server
// still runs), so defaults such as the dev port are asserted without binding
// a fixed port that a dev backend or a parallel run may hold.
vi.mock('./server/static-file-server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./server/static-file-server')>();
  return {
    ...actual,
    createLoopbackServer: vi.fn(actual.createLoopbackServer),
  };
});

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

  it('returns {} (secure device defaults) with no host argv', () => {
    vi.stubGlobal('Bare', undefined);
    expect(resolveWorkletConfig()).toEqual({});
  });

  it('falls back to labeled CLI tokens when positional parsing fails', () => {
    vi.stubGlobal('Bare', {
      argv: ['/usr/local/bin/bare', '/app/worklet/index.js', 'storage=/tmp/s'],
    });
    expect(resolveWorkletConfig()).toEqual({ storage: '/tmp/s' });
  });

  it('never selects dev mode for a broken device configuration', () => {
    // A host whose directories are missing must not end up with auth off.
    vi.stubGlobal('Bare', { argv: ['/missing/web', '/missing/storage'] });
    expect(resolveWorkletConfig()).toEqual({});
  });
});

describe('resolveCliConfig', () => {
  it('keeps the secure device defaults without mode=dev', () => {
    expect(
      resolveCliConfig([
        'webassets=/app/web',
        'storage=/tmp/bare-storage',
        'cache=/tmp/bare-cache',
      ]),
    ).toEqual({
      webAssets: '/app/web',
      storage: '/tmp/bare-storage',
      cache: '/tmp/bare-cache',
    });
    const runtime = createWorkletRuntime(
      resolveCliConfig(['storage=/tmp/bare-storage']),
    );
    expect(runtime.config.deviceMode).toBe(true);
    runtime.close();
  });

  it('mode=dev selects the dev backend (auth off, fixed port)', () => {
    expect(resolveCliConfig(['mode=dev', 'storage=/tmp/s'])).toEqual({
      storage: '/tmp/s',
      deviceMode: false,
      auth: false,
      port: 8080,
    });
    expect(resolveCliConfig(['mode=device'])).toEqual({});
  });

  it('honours auth=, port= and host= overrides', () => {
    expect(
      resolveCliConfig(['mode=dev', 'auth=on', 'port=9000', 'host=0.0.0.0']),
    ).toEqual({
      deviceMode: false,
      auth: true,
      port: 9000,
      host: '0.0.0.0',
    });
    expect(resolveCliConfig(['mode=dev', 'auth=off'])).toMatchObject({
      auth: false,
    });
  });

  it('ignores auth=off outside dev mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveCliConfig(['auth=off'])).toEqual({});
    expect(resolveCliConfig(['auth=0', 'port=0'])).toEqual({ port: 0 });
    expect(warn).toHaveBeenCalledWith(
      '[bare] ignoring auth=off without mode=dev',
    );
    warn.mockRestore();
  });

  it('collects repeatable origin= tokens', () => {
    expect(
      resolveCliConfig([
        'mode=dev',
        'origin=http://localhost:5173',
        'origin=http://127.0.0.1:5173',
      ]),
    ).toMatchObject({
      allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    });
  });

  it('ignores unknown labels (consumer-owned, e.g. bootstrap=...)', () => {
    expect(resolveCliConfig(['bootstrap=127.0.0.1:49737'])).toEqual({});
  });

  it('warns on an invalid port or mode token and keeps the defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveCliConfig(['port=abc', 'port='])).toEqual({});
    expect(resolveCliConfig(['mode=prod'])).toEqual({});
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('returns {} with no labeled tokens', () => {
    expect(resolveCliConfig(['/usr/local/bin/bare', 'index.js'])).toEqual({});
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
    expect(handoff).toEqual({
      origin: creds.origin,
      port: creds.port,
      bootstrap: creds.bootstrap,
    });
    expect(JSON.stringify(handoff)).not.toContain(creds.token);

    // The mounted web app is public content; the WS upgrade stays auth-gated.
    const page = await httpGet(`${creds.origin}/`);
    expect(page.status).toBe(200);
    expect(page.body).toBe('<html>app</html>');

    const upgrade = await wsUpgrade(creds.origin);
    expect(upgrade.split('\r\n')[0]).not.toContain('101');

    runtime.close();
  });

  it('handoffFile: false keeps the credentials off disk', async () => {
    const quietStorage = path.join(root, 'no-handoff-storage');
    fs.mkdirSync(quietStorage, { recursive: true });
    // A stale file from an earlier run is still cleared.
    fs.writeFileSync(path.join(quietStorage, 'handoff.json'), '{}');
    const runtime = createWorkletRuntime({
      webAssets: webDir,
      storage: quietStorage,
      handoffFile: false,
    });

    const creds = await runtime.start();
    expect(creds.token.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(quietStorage, 'handoff.json'))).toBe(false);

    runtime.close();
  });

  it('defaults to device mode (auth on) even without a storage dir', async () => {
    const runtime = createWorkletRuntime({ webAssets: webDir });
    expect(runtime.config.deviceMode).toBe(true);

    const creds = await runtime.start();
    expect(creds.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(creds.origin).not.toBe('http://127.0.0.1:8080');
    const upgrade = await wsUpgrade(creds.origin);
    expect(upgrade.split('\r\n')[0]).not.toContain('101');

    runtime.close();
  });

  it('dev mode: auth off, no handoff file', async () => {
    const runtime = createWorkletRuntime({
      webAssets: webDir,
      deviceMode: false,
      port: 0,
    });
    expect(runtime.config.deviceMode).toBe(false);

    const creds = await runtime.start();
    expect(creds.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const page = await httpGet(`${creds.origin}/`);
    expect(page.status).toBe(200);

    // Dev mode has no storage dir, so it never writes a handoff file.
    expect(runtime.config.storage).toBeUndefined();

    // Auth is off in dev: a token-less upgrade succeeds.
    const upgrade = await wsUpgrade(creds.origin);
    expect(upgrade.split('\r\n')[0]).toContain('101');

    runtime.close();
  });

  it('refuses auth: false in device mode', () => {
    // A-2: device mode is the secure default; `auth: false` without
    // `deviceMode: false` must not open an unauthenticated server.
    const before = vi.mocked(createLoopbackServer).mock.calls.length;
    expect(() =>
      createWorkletRuntime({ webAssets: webDir, auth: false, port: 0 }),
    ).toThrow(/auth: false requires deviceMode: false/);
    expect(() =>
      createWorkletRuntime({ deviceMode: true, auth: false }),
    ).toThrow(/deviceMode: false/);
    // Nothing was built for the refused configuration.
    expect(vi.mocked(createLoopbackServer).mock.calls.length).toBe(before);
  });

  it('dev mode defaults to auth off on port 8080 (asserted without binding)', () => {
    vi.mocked(createLoopbackServer).mockClear();
    const runtime = createWorkletRuntime({ deviceMode: false });
    expect(vi.mocked(createLoopbackServer).mock.calls[0][0]).toMatchObject({
      port: 8080,
      auth: false,
    });
    runtime.close();
  });

  it('deviceMode: false keeps dev semantics with a storage dir (CLI config)', async () => {
    const devStorage = path.join(root, 'cli-dev-storage');
    fs.mkdirSync(devStorage, { recursive: true });
    const runtime = createWorkletRuntime({
      webAssets: webDir,
      storage: devStorage,
      deviceMode: false,
      // Ephemeral: a fixed 8080 collides with a running dev backend (H-12).
      port: 0,
    });
    // Explicit override beats the storage-derived default.
    expect(runtime.config.deviceMode).toBe(false);

    const creds = await runtime.start();
    // Dev semantics apply even though storage is set: auth off, no handoff.
    expect(fs.existsSync(path.join(devStorage, 'handoff.json'))).toBe(false);

    const upgrade = await wsUpgrade(creds.origin);
    expect(upgrade.split('\r\n')[0]).toContain('101');

    runtime.close();
  });

  it('start() is idempotent: one bind, one mount, the same credentials', async () => {
    const runtime = createWorkletRuntime({ webAssets: webDir });
    const mountDir = vi.spyOn(runtime.server, 'mountDir');
    const [a, b] = await Promise.all([runtime.start(), runtime.start()]);
    const c = await runtime.start();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(mountDir).toHaveBeenCalledTimes(1);
    await closeRuntime(runtime);
    await expect(runtime.start()).rejects.toThrow(/after close/);
  });

  it('writes handoff.json atomically, owner-only, leaving no temp file', async () => {
    const atomicStorage = path.join(root, 'atomic-storage');
    fs.mkdirSync(atomicStorage, { recursive: true });
    // A temp file left by a crashed earlier run is cleared too.
    fs.writeFileSync(path.join(atomicStorage, 'handoff.json.tmp'), 'stale');
    const rename = vi.spyOn(fs, 'renameSync');
    const runtime = createWorkletRuntime({
      webAssets: webDir,
      storage: atomicStorage,
    });
    const creds = await runtime.start();
    const target = path.join(atomicStorage, 'handoff.json');
    expect(rename).toHaveBeenCalledWith(
      path.join(atomicStorage, 'handoff.json.tmp'),
      target,
    );
    rename.mockRestore();
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).origin).toBe(
      creds.origin,
    );
    expect(fs.statSync(target).mode & 0o077).toBe(0);
    expect(fs.existsSync(path.join(atomicStorage, 'handoff.json.tmp'))).toBe(
      false,
    );
    await closeRuntime(runtime);
  });

  it('rejects start() when the device handoff file cannot be written', async () => {
    const roStorage = path.join(root, 'unwritable-storage');
    fs.mkdirSync(roStorage, { recursive: true });
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const runtime = createWorkletRuntime({
      webAssets: webDir,
      storage: roStorage,
    });
    try {
      await expect(runtime.start()).rejects.toThrow(
        /failed to write the handoff file: EACCES/,
      );
    } finally {
      write.mockRestore();
      await closeRuntime(runtime);
    }
    expect(fs.existsSync(path.join(roStorage, 'handoff.json'))).toBe(false);
  });

  it('passes the per-channel and per-plugin inflight caps to the router', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      id: 'app.slow',
      events: ['slow.a', 'slow.b'],
      runtimes: {
        bare: {
          invoke: async () => {
            await gate;
            return [null, {}] as [null, object];
          },
        },
      },
    };
    const route = (
      runtime: ReturnType<typeof createWorkletRuntime>,
      event: string,
      requestId: string,
      channel: string,
    ) =>
      runtime.pluginRouter.route(
        { type: 'INVOKE_REQUEST', pluginId: 'app.slow', event, requestId },
        new Uint8Array(0),
        { channel },
      );

    const perChannel = createWorkletRuntime({
      port: 0,
      plugins: [slow],
      maxInflightPerChannel: 1,
    });
    const first = route(perChannel, 'slow.a', 'c1', '[ws]');
    const second = await route(perChannel, 'slow.a', 'c2', '[ws]');
    expect(second?.error?.code).toBe('TRANSPORT_ERROR');

    const perPlugin = createWorkletRuntime({
      port: 0,
      plugins: [slow],
      maxInflightPerPlugin: 1,
    });
    const third = route(perPlugin, 'slow.a', 'p1', '[ws]');
    const fourth = await route(perPlugin, 'slow.b', 'p2', '[ipc]');
    expect(fourth?.error?.code).toBe('TRANSPORT_ERROR');

    release();
    await Promise.all([first, third]);
    await closeRuntime(perChannel);
    await closeRuntime(perPlugin);
  });

  it('registers consumer plugins passed via the plugins option', async () => {
    const photoSpecs = {
      list: {
        pluginId: 'app.photos',
        name: 'photos.list',
        args: {} as Record<string, never>,
        result: {} as { photos: string[] },
      },
    } as const satisfies Record<string, EventSpec<any, any>>;

    const runtime = createWorkletRuntime({
      webAssets: webDir,
      port: 0,
      plugins: [
        definePlugin('app.photos', photoSpecs, {
          capabilities: ['photos'],
          invoke: {
            list: async () => ok({ photos: [] }),
          },
        }),
      ],
    });

    const capabilities = runtime.pluginRegistry.listCapabilities();
    expect(capabilities.some((c) => c.capabilities.includes('photos'))).toBe(
      true,
    );

    runtime.close();
  });
});

describe('runtime teardown', () => {
  async function viewLogs(runtime: ReturnType<typeof createWorkletRuntime>) {
    const response = await runtime.pluginRouter.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.logs',
        event: 'logs.view',
        requestId: `view-${Math.random()}`,
        args: {},
      },
      new Uint8Array(0),
    );
    const result = response?.result as { entries: { message: string }[] };
    return result.entries.map((e) => e.message);
  }

  it('a closed runtime stops receiving console logs, and the console is restored', async () => {
    // H-4: every runtime used to wrap the console again and never unwrap it,
    // so a closed instance kept collecting (and retaining) every later log.
    const before = console.log;
    const a = createWorkletRuntime({ webAssets: webDir });
    await a.start();
    await closeRuntime(a);
    expect(console.log).toBe(before);

    const b = createWorkletRuntime({ webAssets: webDir });
    const c = createWorkletRuntime({ webAssets: webDir });
    // Two live runtimes share one console patch (no stacked wrappers).
    const patched = console.log;
    expect(patched).not.toBe(before);
    console.log('only-after-a-closed');
    expect(await viewLogs(a)).not.toContain('only-after-a-closed');
    expect(await viewLogs(b)).toContain('only-after-a-closed');
    expect(await viewLogs(c)).toContain('only-after-a-closed');
    await closeRuntime(b);
    expect(console.log).toBe(patched);
    await closeRuntime(c);
    expect(console.log).toBe(before);
  });

  it('logsMinLevel still filters per runtime under the shared capture', async () => {
    const quiet = createWorkletRuntime({
      webAssets: webDir,
      logsMinLevel: 'warn',
    });
    const loud = createWorkletRuntime({ webAssets: webDir });
    console.info('info-line');
    expect(await viewLogs(quiet)).not.toContain('info-line');
    expect(await viewLogs(loud)).toContain('info-line');
    await closeRuntime(quiet);
    await closeRuntime(loud);
  });

  it('close() detaches the IPC listener and fails pending host calls', async () => {
    const ipc = Object.assign(new EventEmitter(), {
      write: vi.fn((_data: unknown) => true),
      resume() {},
    });
    vi.stubGlobal('BareKit', { IPC: ipc });
    const runtime = createWorkletRuntime({ port: 0 });
    expect(ipc.listenerCount('data')).toBe(1);
    const bridge = runtime.hostBridge as unknown as {
      close?: (reason?: string) => void;
    };
    const bridgeClose = vi.fn();
    const realClose = bridge.close;
    bridge.close = (reason) => {
      bridgeClose(reason);
      realClose?.call(bridge, reason);
    };

    await closeRuntime(runtime);
    expect(ipc.listenerCount('data')).toBe(0);
    expect(bridgeClose).toHaveBeenCalledTimes(1);
    // A second close is a no-op that still calls back.
    await closeRuntime(runtime);
    expect(bridgeClose).toHaveBeenCalledTimes(1);
  });

  it('forwards per-event host deadlines to the host bridge', async () => {
    const ipc = Object.assign(new EventEmitter(), {
      write: vi.fn((_data: unknown) => true),
      resume() {},
    });
    vi.stubGlobal('BareKit', { IPC: ipc });
    const runtime = createWorkletRuntime({
      port: 0,
      plugins: [
        {
          id: 'app.slowhost',
          events: ['slowhost.call'],
          hostTimeoutsMs: { 'slowhost.call': 123_000 },
          runtimes: { android: { invoke: () => [null, {}] } },
        },
      ],
    });
    const bridge = runtime.hostBridge!;
    bridge.queryCapabilities = vi.fn(async () => [
      {
        pluginId: 'app.slowhost',
        capabilities: [],
        events: ['slowhost.call'],
        runtimes: ['android' as const],
      },
    ]);
    const invokeOnHost = vi.fn(async () => null);
    bridge.invokeOnHost = invokeOnHost;

    // Router delegation carries the manifest's deadline.
    await runtime.pluginRouter.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'app.slowhost',
        event: 'slowhost.call',
        requestId: 'slow-1',
      },
      new Uint8Array(0),
    );
    // A built-in plugin's own host call (vendor.media) carries its deadline.
    await runtime.pluginRouter.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'vendor.media',
        event: 'media.pick',
        requestId: 'pick-1',
        args: { kind: 'image' },
      },
      new Uint8Array(0),
    );
    const deadlines = invokeOnHost.mock.calls.map((c) => (c as unknown[])[2]);
    expect(deadlines[0]).toBe(123_000);
    expect(typeof deadlines[1]).toBe('number');
    await closeRuntime(runtime);
  });

  it('the reference worklet entry handles a failed start()', () => {
    // H-13: `void runtime.start()` turned a bind or handoff failure into an
    // unhandled rejection with no cleanup.
    const entry = fs.readFileSync(
      path.join(
        path.dirname(new URL(import.meta.url).pathname),
        'main.core.ts',
      ),
      'utf8',
    );
    expect(entry).not.toMatch(/void\s+runtime\.start\(\)/);
    expect(entry).toMatch(/runtime\.start\(\)\.catch\(/);
  });
});

function closeRuntime(
  runtime: ReturnType<typeof createWorkletRuntime>,
): Promise<void> {
  return new Promise((resolve) => runtime.close(() => resolve()));
}

/** A credential-less WebSocket upgrade from the bound origin. */
function wsUpgrade(origin: string): Promise<string> {
  const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
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
          'GET /ws HTTP/1.1',
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

describe('host IPC response routing', () => {
  const protocol = new MessageProtocol({
    encode: (str) => new TextEncoder().encode(str),
    decode: (bytes) => new TextDecoder().decode(bytes),
  });
  const frame = (header: Record<string, unknown>) =>
    protocol.encode(
      MessageType.ENVELOPE,
      header as Parameters<typeof protocol.encode>[1],
      null,
    );

  it('consumes host responses while a host-delegated invoke is still waiting on them', async () => {
    const ipc = Object.assign(new EventEmitter(), {
      write: vi.fn((_data: unknown) => true),
      resume() {},
    });
    vi.stubGlobal('BareKit', { IPC: ipc });

    const runtime = createWorkletRuntime({
      port: 0,
      plugins: [
        {
          id: 'app.hosted',
          events: ['hosted.ping'],
          runtimes: { android: { invoke: () => [null, {}] } },
        },
      ],
    });

    const sent = () =>
      ipc.write.mock.calls.map(
        (c) => protocol.decode(new Uint8Array(c[0] as Buffer)).header,
      );
    const nextSent = async (type: string) => {
      await vi.waitFor(
        () =>
          expect(
            sent().map((h) => h.type),
            `waiting for ${type}`,
          ).toContain(type),
        { timeout: 1000 },
      );
      return sent().find((h) => h.type === type) as Record<string, any>;
    };

    // Worklet-bound invoke that the worklet can only answer by calling the
    // host back (capabilities query, then the delegated invoke).
    ipc.emit(
      'data',
      Buffer.from(
        frame({
          type: 'INVOKE_REQUEST',
          pluginId: 'app.hosted',
          event: 'hosted.ping',
          requestId: 'r1',
        }),
      ),
    );

    const query = await nextSent('HOST_CAPABILITIES_QUERY');
    ipc.emit(
      'data',
      Buffer.from(
        frame({
          type: 'HOST_CAPABILITIES_RESPONSE',
          requestId: query.requestId,
          capabilities: [
            {
              pluginId: 'app.hosted',
              capabilities: [],
              events: ['hosted.ping'],
              runtimes: ['android'],
            },
          ],
        }),
      ),
    );

    const hostInvoke = await nextSent('HOST_INVOKE_REQUEST');
    ipc.emit(
      'data',
      Buffer.from(
        frame({
          type: 'HOST_INVOKE_RESPONSE',
          requestId: hostInvoke.requestId,
          pluginId: 'app.hosted',
          event: 'hosted.ping',
          result: { pong: true },
        }),
      ),
    );

    const response = await nextSent('INVOKE_RESPONSE');
    expect(response.requestId).toBe('r1');
    expect(response.result).toEqual({ pong: true });

    runtime.close();
  });

  it('answers a host invoke with FRAME_TOO_LARGE when the result cannot be encoded', async () => {
    const ipc = Object.assign(new EventEmitter(), {
      write: vi.fn((_data: unknown) => true),
      resume() {},
    });
    vi.stubGlobal('BareKit', { IPC: ipc });
    const runtime = createWorkletRuntime({
      port: 0,
      plugins: [
        {
          id: 'app.big',
          events: ['big'],
          runtimes: {
            bare: { invoke: () => [null, { text: 'x'.repeat(70_000) }] },
          },
        },
      ],
    });

    ipc.emit(
      'data',
      Buffer.from(
        frame({
          type: 'INVOKE_REQUEST',
          pluginId: 'app.big',
          event: 'big',
          requestId: 'big-1',
        }),
      ),
    );

    await vi.waitFor(() => expect(ipc.write).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    const header = protocol.decode(
      new Uint8Array(ipc.write.mock.calls[0][0] as Buffer),
    ).header as Record<string, any>;
    expect(header.type).toBe('INVOKE_RESPONSE');
    expect(header.requestId).toBe('big-1');
    expect(header.error.code).toBe('FRAME_TOO_LARGE');

    runtime.close();
  });
});
