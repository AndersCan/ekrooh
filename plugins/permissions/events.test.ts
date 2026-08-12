import { describe, expect, it } from 'vite-plus/test';
import { permissionEvents, permissionSpecs } from './events';

describe('permissionEvents builders', () => {
  it('requestStorage builds the host-delegated invoke envelope', () => {
    expect(permissionEvents.permissions.requestStorage()).toMatchObject({
      kind: 'invoke',
      pluginId: 'core.permissions',
      event: 'permissions.requestStorage',
      args: {},
    });
  });

  it('specs pin the wire event name', () => {
    expect(permissionSpecs.requestStorage.name).toBe(
      'permissions.requestStorage',
    );
  });
});
