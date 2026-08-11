import { EventSpec, invokeEvent } from '../../core/messages';

export type StoragePermissionResult = {
  granted: boolean;
};

export const permissionSpecs = {
  requestStorage: {
    pluginId: 'core.permissions',
    name: 'permissions.requestStorage',
    args: {} as Record<string, never>,
    result: {} as StoragePermissionResult,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const permissionEvents = {
  permissions: {
    requestStorage() {
      return invokeEvent(permissionSpecs.requestStorage, {});
    },
  },
};
