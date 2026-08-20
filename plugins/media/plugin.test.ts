import { describe, expect, it, vi } from 'vite-plus/test';
import { createMediaPlugin } from './plugin';
import type { LoopbackServer } from '../../core/server/static-file-server';
import {
  createPluginRegistry,
  createPluginRouter,
  PluginInvokeResponseHeader,
  type PluginContext,
} from '../../core/messages';

vi.mock('bare-crypto', async () => {
  const crypto = await import('node:crypto');
  return {
    default: {
      randomBytes: (size: number) => crypto.randomBytes(size),
    },
  };
});

const context: PluginContext = { runtime: 'bare', payload: new Uint8Array(0) };

function stubServer(): LoopbackServer {
  return {
    origin: vi.fn(async () => 'http://127.0.0.1:4242'),
    url: vi.fn(async (p: string) => `http://127.0.0.1:4242${p}`),
    token: vi.fn(() => 'testtoken'),
    credentials: vi.fn(async () => ({
      origin: 'http://127.0.0.1:4242',
      port: 4242,
      token: 'testtoken',
      bootstrap: 'test-nonce',
    })),
    mount: vi.fn(),
    unmount: vi.fn(),
    mountDir: vi.fn(),
    onConnection: vi.fn(),
    registerRoute: vi.fn(),
    push: vi.fn(() => true),
    close: vi.fn(),
  };
}

function okHost(result: unknown): () => Promise<PluginInvokeResponseHeader> {
  return async () => ({
    type: 'INVOKE_RESPONSE',
    pluginId: 'vendor.media',
    event: 'media.pick',
    requestId: 'host-1',
    result,
  });
}

describe('createMediaPlugin', () => {
  it('delegates to the host and serves the picked file over HTTP', async () => {
    const staticServer = stubServer();
    const plugin = createMediaPlugin({
      staticServer,
      invokeOnHost: okHost({ path: '/tmp/sample.png' }),
    });
    const invoke = plugin.runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');

    const [error, result] = await invoke(
      'media.pick',
      { kind: 'image' },
      context,
    );
    const media = result as { url: string; path: string } | undefined;

    expect(error).toBeNull();
    expect(media?.path).toBe('/tmp/sample.png');
    expect(media?.url).toMatch(
      /^http:\/\/127\.0\.0\.1:4242\/media\/image-[0-9a-z]+-[A-Za-z0-9_-]+$/,
    );
    expect(media?.url).not.toContain('?token=');
    expect(media?.url).toContain('/media/image-');
    expect(staticServer.url).toHaveBeenCalledWith(
      expect.stringContaining('/media/image-'),
    );
    expect(staticServer.mount).toHaveBeenCalledWith(
      expect.stringContaining('/media/image-'),
      '/tmp/sample.png',
    );
  });

  it('surfaces host errors with the host code', async () => {
    const plugin = createMediaPlugin({
      staticServer: stubServer(),
      invokeOnHost: async () => ({
        type: 'INVOKE_RESPONSE',
        pluginId: 'vendor.media',
        event: 'media.pick',
        requestId: 'host-1',
        error: { code: 'UNSUPPORTED_CAPABILITY', message: 'no picker' },
      }),
    });
    const invoke = plugin.runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');

    const [error, result] = await invoke('media.pick', {}, context);
    expect(result).toBeNull();
    expect(error?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(error?.message).toContain('no picker');
  });

  it('returns HOST_ERROR when the host returns no path', async () => {
    const plugin = createMediaPlugin({
      staticServer: stubServer(),
      invokeOnHost: okHost({}),
    });
    const invoke = plugin.runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');

    const [error] = await invoke('media.pick', {}, context);
    expect(error?.code).toBe('HOST_ERROR');
  });

  it('declares its events and capabilities', () => {
    const plugin = createMediaPlugin({
      staticServer: stubServer(),
      invokeOnHost: okHost({ path: '/tmp/x.png' }),
    });
    expect(plugin.id).toBe('vendor.media');
    expect(plugin.events).toEqual(['media.pick', 'media.capture']);
    expect(plugin.capabilities).toContain('media');
  });

  it('rejects unsupported events deterministically via the router', async () => {
    const registry = createPluginRegistry();
    registry.register(
      createMediaPlugin({
        staticServer: stubServer(),
        invokeOnHost: okHost({ path: '/tmp/x.png' }),
      }),
    );
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'vendor.media',
        event: 'media.bogus',
        requestId: 'r1',
      },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe('UNSUPPORTED_EVENT');
  });
});
