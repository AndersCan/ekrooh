import { describe, expect, it } from 'vite-plus/test';
import { createDiscoveryPlugin } from './plugin';
import type { DiscoveryListResult } from './events';
import type { CapabilityDescriptor, PluginContext } from '../../core/messages';

const context: PluginContext = { runtime: 'bare', payload: new Uint8Array(0) };

function row(
  pluginId: string,
  events: string[],
  runtimes: CapabilityDescriptor['runtimes'] = ['bare'],
): CapabilityDescriptor {
  return { pluginId, capabilities: [], events, runtimes };
}

describe('createDiscoveryPlugin', () => {
  it('lists and merges bare and host capabilities', async () => {
    const plugin = createDiscoveryPlugin({
      listBareCapabilities: () => [
        row('core.health', ['health.ping', 'health.roundtrip']),
        row('core.permissions', []),
      ],
      queryHostCapabilities: async () => [
        row('core.permissions', ['permissions.requestStorage'], ['android']),
      ],
    });
    const invoke = plugin.runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');

    const [error, result] = await invoke('discovery.list', {}, context);
    expect(error).toBeNull();
    const data = result as DiscoveryListResult;
    expect(data.schemaVersion).toBe(1);

    const byId = new Map(data.capabilities.map((c) => [c.pluginId, c]));
    expect(byId.get('core.health')?.events).toEqual([
      'health.ping',
      'health.roundtrip',
    ]);
    const permissions = byId.get('core.permissions');
    expect(permissions?.events).toContain('permissions.requestStorage');
    expect(permissions?.runtimes).toEqual(['bare', 'android']);
  });

  it('rejects unsupported events deterministically', async () => {
    const plugin = createDiscoveryPlugin({
      listBareCapabilities: () => [],
      queryHostCapabilities: async () => [],
    });
    const invoke = plugin.runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');

    const [error, result] = await invoke('discovery.bogus', {}, context);
    expect(result).toBeNull();
    expect(error?.code).toBe('UNSUPPORTED_EVENT');
  });
});
