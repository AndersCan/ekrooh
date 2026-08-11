import fs from 'bare-fs';
import path from 'bare-path';
import { TextDecoder, TextEncoder } from 'bare-encoding';
import { createDefaultPlugins } from '../plugins';
import { getIPC } from './lib/get-ipc';
import { createHostIpcBridge } from './messages/host-ipc';
import { MessageType } from './messages';
import {
  createPluginRegistry,
  createPluginRouter,
  MessageProtocol,
} from './messages/protocol';
import { createLoopbackServer } from './server/static-file-server';
import { attachWebSocketProtocol } from './server/websocket-server';

/** Global provided by the Bare runtime (also present in bare-kit worklets). */
declare const Bare: { argv?: string[] } | undefined;

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

type WorkletConfig = {
  /** Directory to serve at `/` (the built web app). */
  webAssets?: string;
  /** Writable app-sandbox directory for the `handoff.json` port/token file. */
  storage?: string;
};

/**
 * Worklet configuration arrives as `start(...)` arguments (the host's
 * `Worklet.Configuration.assets` is only for bundle-asset unpacking and is not
 * visible to worklet JS). On-device hosts pass `["<webAssets>", "<storage>"]`,
 * landing at `Bare.argv[0..1]`. The Bare CLI (dev) passes the binary and the
 * script path instead, so a missing/absent config means dev mode: auth off,
 * fixed port, no handoff file.
 */
function resolveWorkletConfig(): WorkletConfig {
  const argv =
    typeof Bare !== 'undefined' && Array.isArray(Bare.argv) ? Bare.argv : [];
  const webAssets = argv[0];
  const storage = argv[1];
  if (typeof webAssets === 'string' && typeof storage === 'string') {
    try {
      if (
        fs.statSync(webAssets).isDirectory() &&
        fs.statSync(storage).isDirectory()
      ) {
        return { webAssets, storage };
      }
    } catch {
      // Fall through: not a device configuration.
    }
  }
  return {};
}

let ipc: ReturnType<typeof getIPC> | undefined;
try {
  ipc = getIPC();
} catch {
  ipc = undefined;
}

const protocol = new MessageProtocol({
  encode: (str) => new TextEncoder().encode(str),
  decode: (bytes) => new TextDecoder().decode(bytes),
});

const config = resolveWorkletConfig();
const deviceMode = config.storage !== undefined;

const hostBridge = ipc ? createHostIpcBridge({ ipc, protocol }) : null;
const pluginRegistry = createPluginRegistry();
const loopbackServer = createLoopbackServer({
  auth: deviceMode,
  port: deviceMode ? 0 : 8080,
});
for (const p of createDefaultPlugins({
  listBareCapabilities: () => pluginRegistry.listCapabilities(),
  queryHostCapabilities: () =>
    hostBridge?.queryCapabilities() ?? Promise.resolve([]),
  staticServer: loopbackServer,
  invokeOnHost: (header, payload) =>
    hostBridge?.invokeOnHost(header, payload) ?? Promise.resolve(null),
})) {
  pluginRegistry.register(p);
}

const pluginRouter = createPluginRouter(pluginRegistry, 'bare', {
  delegateToHost: (header, payload) =>
    hostBridge?.invokeOnHost(header, payload) ?? Promise.resolve(null),
});

const runtimeContext = { protocol, pluginRegistry, pluginRouter };

if (ipc) {
  const ipcChannel = ipc;
  ipcChannel.on('data', async (data) => {
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
          ipcChannel,
          protocol.encode(MessageType.ENVELOPE, pluginResponse, null),
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Malformed IPC frame dropped: ${message}`);
    }
  });
}

main();
async function main() {
  // A previous run may have left a handoff file with a dead ephemeral port;
  // remove it so a host polling early never loads a stale origin.
  if (config.storage) {
    try {
      fs.rmSync(path.join(config.storage, 'handoff.json'), { force: true });
    } catch {
      // Nothing to remove.
    }
  }
  if (config.webAssets) {
    loopbackServer.mountDir('/', config.webAssets);
  }
  attachWebSocketProtocol(loopbackServer, runtimeContext);

  const credentials = await loopbackServer.credentials();
  if (deviceMode && config.storage) {
    try {
      fs.writeFileSync(
        path.join(config.storage, 'handoff.json'),
        JSON.stringify(credentials),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to write handoff file: ${message}`);
    }
  }
}
