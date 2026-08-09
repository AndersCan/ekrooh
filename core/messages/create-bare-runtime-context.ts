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
  const protocol = new MessageProtocol({
    encode: (str) => new TextEncoder().encode(str),
    decode: (bytes) => new TextDecoder().decode(bytes),
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
