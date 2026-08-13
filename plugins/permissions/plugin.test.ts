import { describe, expect, it } from 'vite-plus/test';
import { createPermissionsPluginStub } from './plugin';

describe('createPermissionsPluginStub', () => {
  it('declares the permission events and capability but no bare handlers', () => {
    const plugin = createPermissionsPluginStub();
    expect(plugin.id).toBe('core.permissions');
    expect(plugin.events).toEqual([
      'permissions.request',
      'permissions.status',
    ]);
    expect(plugin.capabilities).toContain('permissions');
    expect(plugin.runtimes.bare).toBeUndefined();
  });
});
