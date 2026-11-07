import fs from 'bare-fs';
import path from 'bare-path';
import { createDefaultPlugins } from '../plugins';
import { barePlatform } from './lib/bare-platform';
import { getIPC } from './lib/get-ipc';
import { toIpcChunk } from './messages/bytes';
import { createBareRuntimeContext } from './messages/create-bare-runtime-context';
import { createFrameChannel } from './messages/frame-channel';
import { createHostIpcBridge } from './messages/host-ipc';
import type { MessageProtocol, PluginManifest } from './messages';
import type {
  createPluginRegistry,
  createPluginRouter,
} from './messages/protocol';
import { installConsoleCapture, type ConsoleCapture } from './logs/capture';
import { createLogRingBuffer } from './logs/store';
import { registerLogRoutes } from './logs/routes';
import type { LogLevel, LogStore } from './logs/types';
import {
  createLoopbackServer,
  type LoopbackServer,
} from './server/static-file-server';
import { attachWebSocketProtocol } from './server/websocket-server';

export {
  createLoopbackServer,
  type LoopbackServer,
} from './server/static-file-server';
export {
  collectRequestBody,
  type LoopbackRouteHandler,
} from './server/static-file-server';
export {
  attachWebSocketProtocol,
  createLoopbackPush,
  type LoopbackPush,
} from './server/websocket-server';
export { getIPC } from './lib/get-ipc';

/** Global provided by the Bare runtime (also present in bare-kit worklets). */
declare const Bare:
  | {
      argv?: string[];
      /** `Bare` is an event emitter (`bare-events`): `suspend`, `wakeup`,
       * `idle` and `resume` mark the app's suspension lifecycle. */
      on?(event: string, listener: () => void): unknown;
      off?(event: string, listener: () => void): unknown;
    }
  | undefined;

function readBareArgv(): string[] {
  return typeof Bare !== 'undefined' && Array.isArray(Bare.argv)
    ? Bare.argv
    : [];
}

/** Resolves the host-provided worklet configuration from `start(...)`
 * arguments. On-device hosts pass `["<webAssets>", "<storage>", "<cache>"]`
 * (three existing directories, in that order), landing at `Bare.argv[0..2]`.
 * Falls back to the labeled CLI token syntax (see `resolveCliConfig`) when the
 * positional shape doesn't match, so the same entry works for device and dev
 * runs. Nothing here turns auth off: the dev backend is selected only by an
 * explicit `mode=dev` token. */
export function resolveWorkletConfig(): WorkletRuntimeOptions {
  const argv = readBareArgv();
  const webAssets = argv[0];
  const storage = argv[1];
  const cache = argv[2];
  if (typeof webAssets === 'string' && typeof storage === 'string') {
    try {
      const isDir = (p: string) => fs.statSync(p).isDirectory();
      if (isDir(webAssets) && isDir(storage)) {
        const cacheDir =
          typeof cache === 'string' && isDir(cache) ? cache : storage;
        if (cacheDir !== cache) {
          console.warn(
            `[bare] cache dir missing or not a directory; falling back to the storage dir. ` +
              `Pass three dirs in order to the worklet: [webAssets, storage, cache].`,
          );
        }
        return { webAssets, storage, cache: cacheDir };
      }
    } catch (err) {
      console.debug(
        `[runtime] config dir check failed; not a device configuration: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      // Fall through: not a device configuration.
    }
  }
  return resolveCliConfig(argv);
}

/**
 * Parses labeled-token configuration from bare CLI arguments, one `key=value`
 * per token: `webassets=<dir>`, `storage=<dir>`, `cache=<dir>`,
 * `host=<addr>`, `port=<n>`, `auth=<on|off|true|false|1|0>`,
 * `mode=<device|dev>` and `origin=<scheme://host[:port]>` (repeatable; an
 * extra allowed page origin, e.g. the Vite dev server). Unknown labels (e.g.
 * `bootstrap=127.0.0.1:49737`) are ignored and stay consumer-owned.
 *
 * Without `mode=dev` the result keeps the secure device defaults (auth on, an
 * ephemeral port), and `auth=off` is ignored with a warning. `mode=dev` selects the dev backend: `deviceMode: false`,
 * `auth: false`, `port: 8080`, each overridable by a token. Returns `{}` when
 * no labeled tokens are present.
 */
export function resolveCliConfig(
  argv: readonly string[] = readBareArgv(),
): WorkletRuntimeOptions {
  const parsed: WorkletRuntimeOptions = {};
  const allowedOrigins: string[] = [];
  let dev = false;
  let matched = false;

  for (const token of argv) {
    const m = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(token);
    if (!m) continue;
    const [, key, value] = m;
    matched = true;
    switch (key) {
      case 'webassets':
        parsed.webAssets = value;
        break;
      case 'storage':
        parsed.storage = value;
        break;
      case 'cache':
        parsed.cache = value;
        break;
      case 'host':
        parsed.host = value;
        break;
      case 'port': {
        const n = Number(value);
        if (value !== '' && Number.isInteger(n) && n >= 0 && n <= 65535) {
          parsed.port = n;
        } else {
          console.warn(`[bare] ignoring invalid port= token: "${value}"`);
        }
        break;
      }
      case 'auth':
        parsed.auth = value !== 'off' && value !== 'false' && value !== '0';
        break;
      case 'mode':
        if (value === 'dev') dev = true;
        else if (value !== 'device') {
          console.warn(
            `[bare] ignoring unknown mode= token: "${value}" (expected device or dev)`,
          );
        }
        break;
      case 'origin':
        allowedOrigins.push(value);
        break;
      default:
        // Unknown labels are consumer-owned (e.g. hyperswarm bootstrap).
        break;
    }
  }

  if (!matched) return {};
  if (allowedOrigins.length > 0) parsed.allowedOrigins = allowedOrigins;
  if (dev) return { deviceMode: false, auth: false, port: 8080, ...parsed };
  // Outside dev mode the command line can only keep auth on: an `auth=off`
  // left in a launch script must not quietly open a device-mode server.
  if (parsed.auth === false) {
    console.warn('[bare] ignoring auth=off without mode=dev');
    delete parsed.auth;
  }
  return parsed;
}

export type WorkletRuntimeOptions = {
  /** Directory to serve at `/` (the built web app). */
  webAssets?: string;
  /** Durable app-sandbox directory: `handoff.json` + the p2p corestore. */
  storage?: string;
  /** Ephemeral app-sandbox directory: asset-cache, photo spool, temp. */
  cache?: string;
  /** Bind address. Defaults to `127.0.0.1`. */
  host?: string;
  /** Port to bind; `0` picks an ephemeral port (on-device). Defaults to an
   * ephemeral port in device mode, 8080 in dev mode. */
  port?: number;
  /** Require the per-session token/cookie. Defaults to on in device mode and
   * off in dev mode. The origin check applies either way. `false` is only
   * accepted together with `deviceMode: false`. */
  auth?: boolean;
  /** Extra page origins allowed to call the loopback server, e.g. the Vite dev
   * server (`http://localhost:5173`). The bound origin and its loopback
   * aliases are always allowed. */
  allowedOrigins?: readonly string[];
  /** Write `{ origin, port, bootstrap }` to `<storage>/handoff.json` for the
   * host to read (auth on only; the session token is never written). Defaults
   * to true; a host that receives them over its own channel (the desktop host
   * reads them from a pipe) sets false so nothing touches disk. */
  handoffFile?: boolean;
  /** Device mode (the default): auth on, an ephemeral port, and the handoff
   * file when `storage` is set. Pass `false` (or the `mode=dev` CLI token) for
   * the dev backend: auth off and port 8080 unless set explicitly. Device mode
   * cannot run with `auth: false`: that combination throws. */
  deviceMode?: boolean;
  /** Additional plugin manifests to register after the canonical defaults
   * (consumer product plugins, e.g. `app.photos`). */
  plugins?: PluginManifest[];
  /** Idle timeout (ms) after which an authenticated WebSocket is dropped. */
  wsIdleTimeoutMs?: number;
  /** Dead-peer timeout (ms): a protocol socket that answers no ping within it
   * is destroyed, freeing the slot. Defaults to 10s. */
  wsDeadPeerTimeoutMs?: number;
  /** Minimum gap (ms) before an accepted protocol socket may be replaced by a
   * new authenticated one; an upgrade that arrives sooner is held until then.
   * Defaults to 1s. */
  wsReplaceMinIntervalMs?: number;
  /** Bytes queued behind a protocol socket whose reader stopped reading before
   * server pushes are dropped (newest first). Defaults to 2 MiB. */
  wsMaxQueuedBytes?: number;
  /** Ring capacity for the `core.logs` capture store (retention knob; the
   * rotating file sink is a consumer/app decision). Defaults to 500. */
  logsCapacity?: number;
  /** Global cap on calls routed at once; calls over it fail with a
   * `TRANSPORT_ERROR`. Defaults to 64. */
  maxInflight?: number;
  /** Cap on calls routed at once from one channel (the page socket, the host
   * IPC), so one peer cannot take every slot. Defaults to three quarters of
   * `maxInflight`. */
  maxInflightPerChannel?: number;
  /** Cap on calls routed at once to one plugin, so a slow plugin cannot take
   * every slot. Defaults to `maxInflight` (no per-plugin cap). */
  maxInflightPerPlugin?: number;
  /** Plugin ids whose calls must run one at a time, in arrival order. All
   * other plugins run concurrently, so one slow call never blocks the rest. */
  serialPlugins?: readonly string[];
  /** Lowest level the `core.logs` capture store records (`debug` | `info` |
   * `warn` | `error`). Lower-level console calls still reach stdout. Defaults
   * to `debug` (record everything); raise it to stop routine debug traces
   * from evicting warnings out of a small ring. */
  logsMinLevel?: 'debug' | 'info' | 'warn' | 'error';
};

export type WorkletRuntimeConfig = {
  webAssets?: string;
  storage?: string;
  cache?: string;
  deviceMode: boolean;
};

export interface WorkletRuntime {
  protocol: MessageProtocol;
  pluginRegistry: ReturnType<typeof createPluginRegistry>;
  pluginRouter: ReturnType<typeof createPluginRouter>;
  server: LoopbackServer;
  hostBridge: ReturnType<typeof createHostIpcBridge> | null;
  config: WorkletRuntimeConfig;
  /** Binds the server, mounts the web app, attaches the protocol socket and
   * (in device mode) writes the handoff file. Resolves to the credentials.
   * Idempotent: later calls return the same promise. Rejects when the device
   * handoff file cannot be written (a host would never find the origin) and
   * after `close()`. */
  start(): Promise<{
    origin: string;
    port: number;
    token: string;
    bootstrap: string;
  }>;
  /** Closes the server, detaches the host IPC listener, fails pending host
   * calls and stops feeding this runtime's log store from the console.
   * Idempotent. */
  close(cb?: (err?: Error | null) => void): void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

type ConsoleSink = { store: LogStore; minRank: number };

/** Process-wide console capture shared by every live runtime. The console is
 * patched once, when the first runtime is created, and restored when the
 * last one closes, so N runtimes in one process (the harness) never stack
 * wrappers and a closed runtime's store stops receiving (and retaining) logs. */
const consoleSinks = new Set<ConsoleSink>();
let sharedConsoleCapture: ConsoleCapture | null = null;

const fanOutStore: LogStore = {
  capacity: 0,
  append(entry) {
    const rank = LEVEL_RANK[entry.level];
    for (const sink of consoleSinks) {
      if (rank < sink.minRank) continue;
      try {
        sink.store.append(entry);
      } catch {
        // One broken store must not starve the others or the log call.
      }
    }
  },
  view: () => [],
  clear: () => 0,
};

function attachConsoleSink(store: LogStore, minLevel?: LogLevel): () => void {
  const sink: ConsoleSink = { store, minRank: LEVEL_RANK[minLevel ?? 'debug'] };
  consoleSinks.add(sink);
  if (!sharedConsoleCapture) {
    sharedConsoleCapture = installConsoleCapture(fanOutStore, 'backend');
  }
  return () => {
    if (!consoleSinks.delete(sink)) return;
    if (consoleSinks.size === 0 && sharedConsoleCapture) {
      sharedConsoleCapture.restore();
      sharedConsoleCapture = null;
    }
  };
}

/** Writes `handoff.json` atomically (temp file + rename), so a host polling
 * the storage dir never reads a half-written file. Owner-only permissions:
 * the file carries the bootstrap nonce. */
function writeHandoffFile(
  storage: string,
  handoff: { origin: string; port: number; bootstrap: string },
): void {
  const target = path.join(storage, 'handoff.json');
  const temp = path.join(storage, 'handoff.json.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify(handoff), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best effort: the failure below is what matters.
    }
    throw err;
  }
}

/**
 * Creates one worklet runtime — a per-instance factory (no hardcoded port;
 * the only process-wide state is the shared console capture, which fans out
 * to every live runtime's log store) so the dev/test backend can host
 * N of them and a consumer worklet entry can be just "register plugins +
 * wire p2p". Mirrors the reference wiring in `core/main.core.ts`.
 */
export function createWorkletRuntime(
  options: WorkletRuntimeOptions = {},
): WorkletRuntime {
  const deviceMode = options.deviceMode ?? true;
  if (deviceMode && options.auth === false) {
    // Device mode is the secure default (ADR 0006); an `auth: false` left in
    // consumer options must not quietly open an unauthenticated server.
    throw new Error(
      'createWorkletRuntime: auth: false requires deviceMode: false (the dev ' +
        'backend). Device mode always runs with auth on.',
    );
  }
  const auth = options.auth ?? deviceMode;
  const port = options.port ?? (deviceMode ? 0 : 8080);

  const ipc = getIPC();
  if (!ipc) {
    console.debug(
      '[runtime] no host IPC channel available, running without a host',
    );
  }

  const server = createLoopbackServer({
    host: options.host,
    port,
    auth,
    allowedOrigins: options.allowedOrigins,
    wsIdleTimeoutMs: options.wsIdleTimeoutMs,
    wsDeadPeerTimeoutMs: options.wsDeadPeerTimeoutMs,
    wsReplaceMinIntervalMs: options.wsReplaceMinIntervalMs,
    wsMaxQueuedBytes: options.wsMaxQueuedBytes,
  });

  // The host bridge needs the context's protocol and the router needs the
  // bridge; the router only calls into it at route time, after both exist.
  let hostBridge: ReturnType<typeof createHostIpcBridge> | null = null;
  const context = createBareRuntimeContext([], {
    maxInflight: options.maxInflight,
    maxInflightPerChannel: options.maxInflightPerChannel,
    maxInflightPerPlugin: options.maxInflightPerPlugin,
    serialPlugins: options.serialPlugins,
    // The event's own host deadline (`timeoutMs`) must reach the bridge, or
    // every delegated call falls back to the bridge default.
    delegateToHost: (header, payload, timeoutMs) =>
      hostBridge?.invokeOnHost(header, payload, timeoutMs) ??
      Promise.resolve(null),
    getHostCapabilities: () =>
      hostBridge?.queryCapabilities() ?? Promise.resolve([]),
  });
  const { protocol, pluginRegistry, pluginRouter } = context;
  hostBridge = ipc
    ? createHostIpcBridge({ ipc, protocol, platform: barePlatform })
    : null;

  // `core.logs`: the worklet capture seam (console interception), the shared
  // ring buffer fed by both the seam and the web ingest route, and the loopback
  // log routes. Retention is a consumer knob (`logsCapacity`); the rotating file
  // sink is an app decision, kept out of the framework.
  const logStore = createLogRingBuffer(options.logsCapacity ?? 500);
  registerLogRoutes(server, logStore);

  for (const plugin of createDefaultPlugins({
    listBareCapabilities: () => pluginRegistry.listCapabilities(),
    queryHostCapabilities: () =>
      hostBridge?.queryCapabilities() ?? Promise.resolve([]),
    staticServer: server,
    invokeOnHost: (header, payload, timeoutMs) =>
      hostBridge?.invokeOnHost(header, payload, timeoutMs) ??
      Promise.resolve(null),
    store: logStore,
  })) {
    pluginRegistry.register(plugin);
  }
  for (const plugin of options.plugins ?? []) {
    pluginRegistry.register(plugin);
  }

  // Patch the console only once nothing above can throw: a factory that fails
  // (a reserved or duplicate plugin id) returns no runtime to close, so a sink
  // attached earlier would leak and keep the console patched for good.
  const detachConsole = attachConsoleSink(logStore, options.logsMinLevel);

  // The bootstrap nonce's lifetime counts running time only: a page
  // backgrounded between load and `/login` must still log in on resume. Only
  // `resume` restarts the clock; `wakeup` is a brief pass while still
  // suspended.
  const onSuspend = () => server.pauseBootstrapClock?.();
  const onResume = () => server.resumeBootstrapClock?.();
  const bareEvents =
    typeof Bare !== 'undefined' && typeof Bare?.on === 'function' ? Bare : null;
  bareEvents?.on?.('suspend', onSuspend);
  bareEvents?.on?.('resume', onResume);

  let onIpcData: ((data: unknown) => void) | null = null;
  if (ipc) {
    const bridge = hostBridge;
    // Host→worklet frames arrive over a stream whose `data` events do not
    // preserve message boundaries. The IPC pipe has no reconnect seam, so a
    // malformed frame is dropped and parsing resumes, until a sustained run
    // proves the stream is desynced for good.
    const channel = createFrameChannel({
      name: '[ipc]',
      protocol,
      router: pluginRouter,
      write: (frame) => ipc.write(toIpcChunk(frame)),
      onMalformed: { kind: 'tolerate' },
      // Host responses resolve a call the worklet is already waiting on, so
      // consume them ahead of any request work: queued behind the request
      // that is waiting for them they would stall until timeout.
      intercept: (message) => bridge?.tryConsumeDownstream(message) ?? false,
    });
    onIpcData = (data: unknown) => channel.push(data);
    ipc.on('data', onIpcData);
  }

  let closed = false;
  let started: ReturnType<WorkletRuntime['start']> | null = null;

  async function startOnce() {
    if (options.storage) {
      // A previous run may have left a handoff file with a dead ephemeral
      // port; remove it so a host polling early never loads a stale origin.
      try {
        fs.rmSync(path.join(options.storage, 'handoff.json'), { force: true });
        fs.rmSync(path.join(options.storage, 'handoff.json.tmp'), {
          force: true,
        });
      } catch {
        console.debug('[runtime] no existing handoff file to remove');
        // Nothing to remove.
      }
    }
    if (options.webAssets) {
      server.mountDir('/', options.webAssets, { public: true });
    }
    attachWebSocketProtocol(server, { protocol, pluginRegistry, pluginRouter });

    const credentials = await server.credentials();
    // handoff.json exists for the host to find the origin and the page's
    // bootstrap nonce; only device mode (auth on) writes it — a dev backend
    // with `auth: false` and a storage dir for persistence must not leave a
    // stale handoff behind. The session token stays out of it: a host never
    // needs it to load the page, and the file sits on disk until the host
    // deletes it.
    if (auth && options.storage && options.handoffFile !== false) {
      const { origin, port, bootstrap } = credentials;
      try {
        writeHandoffFile(options.storage, { origin, port, bootstrap });
      } catch (err) {
        // A host that cannot find the handoff would poll until it times out
        // with no reason given: fail start() instead, loudly.
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[runtime] failed to write the handoff file: ${message}`,
        );
      }
    }
    return credentials;
  }

  return {
    protocol,
    pluginRegistry,
    pluginRouter,
    server,
    hostBridge,
    config: {
      webAssets: options.webAssets,
      storage: options.storage,
      cache: options.cache,
      deviceMode,
    },
    start() {
      if (closed) {
        return Promise.reject(new Error('[runtime] start() after close()'));
      }
      started ??= startOnce();
      return started;
    },
    close(cb) {
      if (closed) {
        cb?.(null);
        return;
      }
      closed = true;
      bareEvents?.off?.('suspend', onSuspend);
      bareEvents?.off?.('resume', onResume);
      detachConsole();
      if (ipc && onIpcData) ipc.removeListener('data', onIpcData);
      // Pending host calls would otherwise wait out their timeout (up to
      // minutes for media) after the runtime is gone.
      (hostBridge as { close?: (reason?: string) => void } | null)?.close?.(
        'worklet runtime closed',
      );
      server.close(cb);
    },
  };
}
