import { describe, expect, it } from 'vite-plus/test';
import { createDefaultPlugins, type DefaultPluginsDeps } from './index';
import type { MediaPluginDeps } from './media/plugin';

const deps: DefaultPluginsDeps = {
  listBareCapabilities: () => [],
  queryHostCapabilities: async () => [],
  staticServer: {
    mount: () => {},
  } as unknown as MediaPluginDeps['staticServer'],
  invokeOnHost: async () => null,
};

describe('createDefaultPlugins', () => {
  it('returns the canonical plugin set in order', () => {
    const plugins = createDefaultPlugins(deps);
    expect(plugins.map((p) => p.id)).toEqual([
      'core.health',
      'core.discovery',
      'core.permissions',
      'vendor.media',
    ]);
    for (const plugin of plugins) {
      expect(plugin.events?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
