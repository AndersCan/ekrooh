import fs from 'bare-fs';
import path from 'bare-path';
import { TextDecoder, TextEncoder } from 'bare-encoding';
import { createDefaultPlugins } from '../plugins';
import { getIPC } from './lib/get-ipc';
import { createFrameDecoder } from './messages/framing';
import { ChannelHealth } from './messages/channel-health';
import { createHostIpcBridge } from './messages/host-ipc';
import { MessageType, MessageProtocol, type PluginManifest } from './messages';
import { createPluginRegistry, createPluginRouter } from './messages/protocol';
import { installConsoleCapture } from './logs/capture';
import { createLogRingBuffer } from './logs/store';
import { registerLogRoutes } from './logs/routes';
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
declare const Bare: { argv?: string[] } | undefined;

function readBareArgv(): string[] {
  return typeof Bare !== 'undefined' && Array.isArray(Bare.argv)
    ? Bare.argv
    : [];
}

/** Resolves the host-provided worklet configuration from `start(...)`
 * arguments. On-device hosts pass `["<webAssets>", "<storage>", "<cache>"]`
 * (three existing directories, in that order), landing at `Bare.argv[0..2]`;
 * the Bare CLI (dev) passes the binary and the script path instead, so a
 * missing/absent config means dev mode (auth off, fixed port, no handoff
 * file). Falls back to the labeled CLI token syntax (see `resolveCliConfig`)
 * when the positional shape doesn't match, so the same entry works for both
 * device and dev runs. */
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
 * Parses the dev/CLI labeled-token configuration from bare CLI arguments:
 * `webassets=<dir>`, `storage=<dir>`, `cache=<dir>`, `host=<addr>`,
 * `port=<n>`, `auth=<on|off|true|false|1|0>` — a single `key=value` separator.
 * Unknown labels (e.g. `bootstrap=127.0.0.1:49737`) are ignored and stay
 * consumer-owned.
 *
 * Returns the equivalent `WorkletRuntimeOptions` in **dev mode**: `deviceMode:
 * false` (so a `storage=` token does not flip auth on or make the port
 * ephemeral), `auth: false`, `port: 8080`, each overridable by a token. When
 * no labeled tokens are present it returns `{}` (plain dev defaults).
 */
export function resolveCliConfig(
  argv: readonly string[] = readBareArgv(),
): WorkletRuntimeOptions {
  const parsed: {
    webAssets?: string;
    storage?: string;
    cache?: string;
    host?: string;
    port?: number;
    auth?: boolean;
  } = {};
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
        if (Number.isInteger(n) && n >= 0 && n <= 65535) {
          parsed.port = n;
        } else {
          console.warn(`[bare] ignoring invalid port= token: "${value}"`);
        }
        break;
      }
      case 'auth':
        parsed.auth = value !== 'off' && value !== 'false' && value !== '0';
        break;
      default:
        // Unknown labels are consumer-owned (e.g. hyperswarm bootstrap).
        break;
    }
  }

  if (!matched) return {};
  return {
    deviceMode: false,
    auth: false,
    port: 8080,
    ...parsed,
  };
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
  /** Require the per-session token/cookie. Defaults to on in device mode. */
  auth?: boolean;
  /** Explicit device-mode override. Defaults to on whenever `storage` is set
   * (the on-device 3-arg contract); `resolveCliConfig` resolves it to false so
   * a dev backend keeps auth off + fixed port even with a storage dir. */
  deviceMode?: boolean;
  /** Additional plugin manifests to register after the canonical defaults
   * (consumer product plugins, e.g. `app.photos`). */
  plugins?: PluginManifest[];
  /** Idle timeout (ms) after which an authenticated WebSocket is dropped. */
  wsIdleTimeoutMs?: number;
  /** Ring capacity for the `core.logs` capture store (retention knob; the
   * rotating file sink is a consumer/app decision). Defaults to 500. */
  logsCapacity?: number;
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
   * (in device mode) writes the handoff file. Resolves to the credentials. */
  start(): Promise<{
    origin: string;
    port: number;
    token: string;
    bootstrap: string;
  }>;
  close(cb?: (err?: Error | null) => void): void;
}

function toUint8Array(data: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data))
    return new Uint8Array(data);
  return new Uint8Array(data as ArrayBuffer);
}

function writeIpc(
  ipc: { write(data: Buffer | string): boolean },
  bytes: Uint8Array,
) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    ipc.write(Buffer.from(bytes));
  } else {
    ipc.write(bytes as unknown as Buffer);
  }
}

/**
 * Creates one worklet runtime — a per-instance, stateless factory (no
 * module-scope singletons, no hardcoded port) so the dev/test backend can host
 * N of them and a consumer worklet entry can be just "register plugins +
 * wire p2p". Mirrors the reference wiring in `core/main.core.ts`.
 */
export function createWorkletRuntime(
  options: WorkletRuntimeOptions = {},
): WorkletRuntime {
  const deviceMode = options.deviceMode ?? options.storage !== undefined;
  const auth = options.auth ?? deviceMode;
  const port = options.port ?? (deviceMode ? 0 : 8080);

  const protocol = new MessageProtocol({
    encode: (str) => new TextEncoder().encode(str),
    decode: (bytes) => new TextDecoder().decode(bytes),
  });

  let ipc: ReturnType<typeof getIPC> | undefined;
  try {
    ipc = getIPC();
  } catch (err) {
    console.debug(
      `[runtime] no host IPC channel available, running without a host: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    ipc = undefined;
  }

  const hostBridge = ipc ? createHostIpcBridge({ ipc, protocol }) : null;
  const pluginRegistry = createPluginRegistry();
  const server = createLoopbackServer({
    host: options.host,
    port,
    auth,
    wsIdleTimeoutMs: options.wsIdleTimeoutMs,
  });

  // `core.logs`: the worklet capture seam (console interception), the shared
  // ring buffer fed by both the seam and the web ingest route, and the loopback
  // log routes. Retention is a consumer knob (`logsCapacity`); the rotating file
  // sink is an app decision, kept out of the framework.
  const logStore = createLogRingBuffer(options.logsCapacity ?? 500);
  installConsoleCapture(logStore, 'backend');
  registerLogRoutes(server, logStore);

  for (const plugin of createDefaultPlugins({
    listBareCapabilities: () => pluginRegistry.listCapabilities(),
    queryHostCapabilities: () =>
      hostBridge?.queryCapabilities() ?? Promise.resolve([]),
    staticServer: server,
    invokeOnHost: (header, payload) =>
      hostBridge?.invokeOnHost(header, payload) ?? Promise.resolve(null),
    store: logStore,
  })) {
    pluginRegistry.register(plugin);
  }
  for (const plugin of options.plugins ?? []) {
    pluginRegistry.register(plugin);
  }

  const pluginRouter = createPluginRouter(pluginRegistry, 'bare', {
    delegateToHost: (header, payload) =>
      hostBridge?.invokeOnHost(header, payload) ?? Promise.resolve(null),
    getHostCapabilities: () =>
      hostBridge?.queryCapabilities() ?? Promise.resolve([]),
  });

  if (ipc) {
    // Host→worklet frames arrive over a Node-style Readable whose `data` events
    // do not preserve message boundaries, so frames arrive split or coalesced.
    // The per-runtime frame decoder drains synchronously and the downstream
    // handling is serialized, so concurrent data events cannot interleave.
    const ipcDecoder = createFrameDecoder(protocol);
    const ipcHealth = new ChannelHealth();
    let inflight: Promise<void> = Promise.resolve();

    ipc.on('data', (data) => {
      // A permanently desynced IPC pipe has no reconnect seam, so once a
      // sustained run of malformed frames proves the byte stream is lost, stop
      // parsing rather than silently eating garbage for the rest of the session.
      if (ipcHealth.isFatal) return;
      let messages;
      try {
        messages = ipcDecoder.push(toUint8Array(data as Uint8Array));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Malformed IPC frame dropped: ${message}`);
        // One bad chunk may legitimately desync the byte stream; allow a short
        // burst of recoverable failures but treat a sustained run as fatal.
        if (ipcHealth.noteFailure()) {
          console.error(
            'IPC channel permanently desynced after repeated malformed frames; stopping host→worklet frame parsing',
          );
          return;
        }
        ipcDecoder.clear();
        return;
      }
      ipcHealth.noteSuccess();
      if (messages.length === 0) return;

      inflight = inflight
        .then(async () => {
          for (const parsed of messages) {
            if (hostBridge?.tryConsumeDownstream(parsed)) {
              continue;
            }
            const pluginResponse = await pluginRouter.route(
              parsed.header,
              parsed.payload,
            );
            if (pluginResponse) {
              writeIpc(
                ipc,
                protocol.encode(MessageType.ENVELOPE, pluginResponse, null),
              );
            }
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Malformed IPC frame dropped: ${message}`);
        });
    });
  }

  async function start() {
    if (options.storage) {
      // A previous run may have left a handoff file with a dead ephemeral
      // port; remove it so a host polling early never loads a stale origin.
      try {
        fs.rmSync(path.join(options.storage, 'handoff.json'), { force: true });
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
    // handoff.json exists for the host to find origin/port/token; only device
    // mode (auth on) writes it — a dev backend with `auth: false` and a
    // storage dir for persistence must not leave a stale handoff behind.
    if (auth && options.storage) {
      try {
        fs.writeFileSync(
          path.join(options.storage, 'handoff.json'),
          JSON.stringify(credentials),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to write handoff file: ${message}`);
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
    start,
    close(cb) {
      server.close(cb);
    },
  };
}
