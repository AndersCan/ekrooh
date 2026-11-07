import { EventSpec, invokeEvent, InvokeEnvelope } from '../../core/messages';

/** Canonical permission ids. Hosts map each to their platform equivalent. */
export type PermissionId = 'storage' | 'camera';

export type PermissionStatus =
  | 'granted'
  | 'denied'
  | 'notDetermined'
  | 'unsupported';

export type PermissionResult = {
  permission: PermissionId;
  status: PermissionStatus;
};

/**
 * A permission request shows a system prompt the user answers at their own pace, so
 * the worklet waits as long for the host as the page waits for the worklet (R-04).
 */
const PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export const permissionSpecs = {
  request: {
    pluginId: 'core.permissions',
    name: 'permissions.request',
    args: {} as { permission: PermissionId },
    result: {} as PermissionResult,
    hostTimeoutMs: PERMISSION_REQUEST_TIMEOUT_MS,
  },
  status: {
    pluginId: 'core.permissions',
    name: 'permissions.status',
    args: {} as { permission: PermissionId },
    result: {} as PermissionResult,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const permissionEvents = {
  permissions: {
    request(
      permission: PermissionId,
    ): InvokeEnvelope<
      'permissions.request',
      { permission: PermissionId },
      PermissionResult
    > {
      return invokeEvent(permissionSpecs.request, { permission });
    },
    status(
      permission: PermissionId,
    ): InvokeEnvelope<
      'permissions.status',
      { permission: PermissionId },
      PermissionResult
    > {
      return invokeEvent(permissionSpecs.status, { permission });
    },
  },
};
