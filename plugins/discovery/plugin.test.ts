import { describe, expect, it } from 'vite-plus/test';
import { createDiscoveryPlugin } from './plugin';
import type { DiscoveryListResult } from './events';
import {
  createPluginRegistry,
  createPluginRouter,
  type CapabilityDescriptor,
  type PluginContext,
} from '../../core/messages';

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
        row(
          'core.permissions',
          ['permissions.request', 'permissions.status'],
          ['android'],
        ),
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
    expect(permissions?.events).toContain('permissions.request');
    expect(permissions?.events).toContain('permissions.status');
    expect(permissions?.runtimes).toEqual(['bare', 'android']);
  });

  it('rejects unsupported events deterministically via the router', async () => {
    const registry = createPluginRegistry();
    registry.register(
      createDiscoveryPlugin({
        listBareCapabilities: () => [],
        queryHostCapabilities: async () => [],
      }),
    );
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.discovery',
        event: 'discovery.bogus',
        requestId: 'r1',
      },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe('UNSUPPORTED_EVENT');
  });
});
