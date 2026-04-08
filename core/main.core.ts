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
import { startWebSocketServer } from './server/websocket-server';

function toUint8Array(data: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return new Uint8Array(data);
  return new Uint8Array(data as ArrayBuffer);
}

function writeIpc(ipc: { write(data: Buffer | string): boolean }, bytes: Uint8Array) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    ipc.write(Buffer.from(bytes));
  } else {
    ipc.write(bytes as unknown as Buffer);
  }
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

const hostBridge = ipc ? createHostIpcBridge({ ipc, protocol }) : null;
const pluginRegistry = createPluginRegistry();
for (const p of createDefaultPlugins({
  listBareCapabilities: () => pluginRegistry.listCapabilities(),
  queryHostCapabilities: () => hostBridge?.queryCapabilities() ?? Promise.resolve([]),
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
        writeIpc(ipcChannel, protocol.encode(MessageType.ENVELOPE, pluginResponse, null));
      }
    } catch {
      /* ignore malformed frames */
    }
  });
}

main();
async function main() {
  startWebSocketServer(runtimeContext);
}
