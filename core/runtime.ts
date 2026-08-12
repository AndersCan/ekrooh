import fs from 'bare-fs';
import path from 'bare-path';
import { TextDecoder, TextEncoder } from 'bare-encoding';
import { createDefaultPlugins } from '../plugins';
import { getIPC } from './lib/get-ipc';
import { createHostIpcBridge } from './messages/host-ipc';
import { MessageType, MessageProtocol } from './messages';
import { createPluginRegistry, createPluginRouter } from './messages/protocol';
import {
  createLoopbackServer,
  type LoopbackServer,
} from './server/static-file-server';
import { attachWebSocketProtocol } from './server/websocket-server';

export {
  createLoopbackServer,
  type LoopbackServer,
} from './server/static-file-server';
export { attachWebSocketProtocol } from './server/websocket-server';
export { getIPC } from './lib/get-ipc';

/** Global provided by the Bare runtime (also present in bare-kit worklets). */
declare const Bare: { argv?: string[] } | undefined;

/** Resolves the host-provided worklet configuration from `start(...)`
 * arguments. On-device hosts pass `["<webAssets>", "<storage>", "<cache>"]`,
 * landing at `Bare.argv[0..2]`; the Bare CLI (dev) passes the binary and the
 * script path instead, so a missing/absent config means dev mode (auth off,
 * fixed port, no handoff file). */
export function resolveWorkletConfig(): WorkletRuntimeOptions {
  const argv =
    typeof Bare !== 'undefined' && Array.isArray(Bare.argv) ? Bare.argv : [];
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
            '[bare] cache dir missing or not a directory; falling back to the storage dir',
          );
        }
        return { webAssets, storage, cache: cacheDir };
      }
    } catch {
      // Fall through: not a device configuration.
    }
  }
  return {};
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
  /** Idle timeout (ms) after which an authenticated WebSocket is dropped. */
  wsIdleTimeoutMs?: number;
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
  start(): Promise<{ origin: string; port: number; token: string }>;
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
  const deviceMode = options.storage !== undefined;
  const auth = options.auth ?? deviceMode;
  const port = options.port ?? (deviceMode ? 0 : 8080);

  const protocol = new MessageProtocol({
    encode: (str) => new TextEncoder().encode(str),
    decode: (bytes) => new TextDecoder().decode(bytes),
  });

  let ipc: ReturnType<typeof getIPC> | undefined;
  try {
    ipc = getIPC();
  } catch {
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

  for (const plugin of createDefaultPlugins({
    listBareCapabilities: () => pluginRegistry.listCapabilities(),
    queryHostCapabilities: () =>
      hostBridge?.queryCapabilities() ?? Promise.resolve([]),
    staticServer: server,
    invokeOnHost: (header, payload) =>
      hostBridge?.invokeOnHost(header, payload) ?? Promise.resolve(null),
  })) {
    pluginRegistry.register(plugin);
  }

  const pluginRouter = createPluginRouter(pluginRegistry, 'bare', {
    delegateToHost: (header, payload) =>
      hostBridge?.invokeOnHost(header, payload) ?? Promise.resolve(null),
  });

  if (ipc) {
    ipc.on('data', async (data) => {
      try {
        const raw = toUint8Array(data as Uint8Array);
        if (hostBridge?.tryConsumeDownstreamFromHost(raw)) {
          return;
        }
        const parsed = protocol.decode(raw);
        const header = parsed.header;
        const pluginResponse = await pluginRouter.route(header, parsed.payload);
        if (pluginResponse) {
          writeIpc(
            ipc,
            protocol.encode(MessageType.ENVELOPE, pluginResponse, null),
          );
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`Malformed IPC frame dropped: ${message}`);
      }
    });
  }

  async function start() {
    if (options.storage) {
      // A previous run may have left a handoff file with a dead ephemeral
      // port; remove it so a host polling early never loads a stale origin.
      try {
        fs.rmSync(path.join(options.storage, 'handoff.json'), { force: true });
      } catch {
        // Nothing to remove.
      }
    }
    if (options.webAssets) {
      server.mountDir('/', options.webAssets);
    }
    attachWebSocketProtocol(server, { protocol, pluginRegistry, pluginRouter });

    const credentials = await server.credentials();
    if (deviceMode && options.storage) {
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
