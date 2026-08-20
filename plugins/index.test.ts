import { describe, expect, it, vi } from 'vite-plus/test';
import { createDefaultPlugins, type DefaultPluginsDeps } from './index';
import type { MediaPluginDeps } from './media/plugin';
import { createLogRingBuffer } from '../core/logs/store';

vi.mock('bare-crypto', async () => {
  const crypto = await import('node:crypto');
  return {
    default: {
      randomBytes: (size: number) => crypto.randomBytes(size),
    },
  };
});

const deps: DefaultPluginsDeps = {
  listBareCapabilities: () => [],
  queryHostCapabilities: async () => [],
  staticServer: {
    mount: () => {},
  } as unknown as MediaPluginDeps['staticServer'],
  invokeOnHost: async () => null,
  store: createLogRingBuffer(100),
};

describe('createDefaultPlugins', () => {
  it('returns the canonical plugin set in order', () => {
    const plugins = createDefaultPlugins(deps);
    expect(plugins.map((p) => p.id)).toEqual([
      'core.health',
      'core.discovery',
      'core.permissions',
      'vendor.media',
      'core.logs',
    ]);
    for (const plugin of plugins) {
      expect(plugin.events?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
