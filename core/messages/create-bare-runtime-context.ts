import { TextDecoder, TextEncoder } from 'bare-encoding';
import {
  MessageProtocol,
  PluginManifest,
  PluginRegistry,
  PluginRouter,
  RuntimeTarget,
  createPluginRegistry,
  createPluginRouter,
  type PluginRouterOptions,
} from './protocol';

export interface BareRuntimeContext {
  protocol: MessageProtocol;
  pluginRegistry: PluginRegistry;
  pluginRouter: PluginRouter;
}

export function createBareRuntimeContext(
  plugins: PluginManifest[] = [],
  routerOptions?: PluginRouterOptions,
): BareRuntimeContext {
  const runtime: RuntimeTarget = 'bare';
  // One encoder/decoder per context, not one per frame.
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const protocol = new MessageProtocol({
    encode: (str) => textEncoder.encode(str),
    decode: (bytes) => textDecoder.decode(bytes),
  });
  const pluginRegistry = createPluginRegistry();
  for (const plugin of plugins) {
    pluginRegistry.register(plugin);
  }
  const pluginRouter = createPluginRouter(
    pluginRegistry,
    runtime,
    routerOptions,
  );

  return { protocol, pluginRegistry, pluginRouter };
}
