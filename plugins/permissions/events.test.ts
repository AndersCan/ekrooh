import { describe, expect, it } from 'vite-plus/test';
import { permissionEvents, permissionSpecs } from './events';

describe('permissionEvents builders', () => {
  it('request builds the host-delegated invoke envelope', () => {
    expect(permissionEvents.permissions.request('camera')).toMatchObject({
      kind: 'invoke',
      pluginId: 'core.permissions',
      event: 'permissions.request',
      args: { permission: 'camera' },
    });
  });

  it('status builds the host-delegated invoke envelope', () => {
    expect(permissionEvents.permissions.status('storage')).toMatchObject({
      kind: 'invoke',
      pluginId: 'core.permissions',
      event: 'permissions.status',
      args: { permission: 'storage' },
    });
  });

  it('specs pin the wire event names', () => {
    expect(permissionSpecs.request.name).toBe('permissions.request');
    expect(permissionSpecs.status.name).toBe('permissions.status');
  });
});
