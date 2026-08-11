import {
  definePlugin,
  err,
  ErrorCode,
  ok,
  PluginInvokeRequestHeader,
  PluginInvokeResponseHeader,
  PluginManifest,
} from '../../core/messages';
import type { LoopbackServer } from '../../core/server/static-file-server';
import { mediaSpecs, MediaKind } from './events';

export type MediaPluginDeps = {
  /** Worklet-side loopback server exposing picked files to the web layer. */
  staticServer: LoopbackServer;
  /** Delegates the native pick/capture to the host (`HOST_INVOKE_REQUEST`). */
  invokeOnHost: (
    header: PluginInvokeRequestHeader,
    payload: Uint8Array,
  ) => Promise<PluginInvokeResponseHeader | null>;
};

function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * `vendor.media` — reference plugin demonstrating out-of-band binary transfer.
 * The native host picks/captures a file (returns its path); the worklet mounts
 * it on its loopback HTTP server and hands the web layer a plain URL. No media
 * bytes ever cross the wire protocol or a WebView bridge, and the serving code
 * is identical on every runtime.
 */
export function createMediaPlugin(deps: MediaPluginDeps): PluginManifest {
  const serve = async (
    event: 'media.pick' | 'media.capture',
    args: { kind?: MediaKind } | undefined,
  ) => {
    const host = await deps.invokeOnHost(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'vendor.media',
        event,
        requestId: newRequestId(),
        args,
      },
      new Uint8Array(0),
    );
    if (!host) {
      return err(ErrorCode.HOST_ERROR, `Host did not answer ${event}`);
    }
    if (host.error) {
      return err(
        (host.error.code as ErrorCode) || ErrorCode.HOST_ERROR,
        host.error.message ?? `Host failed ${event}`,
      );
    }
    const path = (host.result as { path?: string } | undefined)?.path;
    if (!path) {
      return err(ErrorCode.HOST_ERROR, `Host returned no path for ${event}`);
    }
    const kind = args?.kind ?? 'media';
    const id = `${kind}-${newRequestId()}`;
    deps.staticServer.mount(`/media/${id}`, path);
    const url = await deps.staticServer.url(`/media/${id}`);
    return ok({ url, path });
  };

  return definePlugin('vendor.media', mediaSpecs, {
    capabilities: ['media'],
    invoke: {
      pick: async (args) => serve('media.pick', args),
      capture: async (args) => serve('media.capture', args),
    },
  });
}
