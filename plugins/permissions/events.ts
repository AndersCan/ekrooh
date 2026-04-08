import { InvokeEnvelope } from '../../core/messages';

export type StoragePermissionResult = {
  granted: boolean;
};

export const permissionEvents = {
  permissions: {
    requestStorage(): InvokeEnvelope<
      'permissions.requestStorage',
      Record<string, never>,
      StoragePermissionResult
    > {
      return {
        kind: 'invoke',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        args: {},
      };
    },
  },
};
