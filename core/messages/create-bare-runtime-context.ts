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
    decode: (bytes) =>
      strictUtf8(bytes, textDecoder.decode(bytes), textEncoder),
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

/** Bare's `TextDecoder` has no `fatal` mode: it substitutes U+FFFD for invalid
 * UTF-8. Decoding is strict on every other runtime, so a header that only
 * decodes by substitution is refused here too (the codec turns the throw into
 * `FRAME_INVALID`). A decoded string holds U+FFFD either because the bytes
 * held one (EF BF BD) or because the decoder substituted it; re-encoding tells
 * them apart, and only strings that contain one pay for it. */
function strictUtf8(
  bytes: Uint8Array,
  decoded: string,
  encoder: { encode(str: string): Uint8Array },
): string {
  if (!decoded.includes('\uFFFD')) return decoded;
  const roundTrip = encoder.encode(decoded);
  if (roundTrip.byteLength !== bytes.byteLength) {
    throw new TypeError('invalid UTF-8');
  }
  for (let i = 0; i < bytes.byteLength; i++) {
    if (roundTrip[i] !== bytes[i]) throw new TypeError('invalid UTF-8');
  }
  return decoded;
}
