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
 * A permission request shows a system prompt the user answers at their own pace
 * (R-04). The page waits five minutes; the worklet waits slightly less for the
 * host, so a host that never answers fails the call with a `TIMEOUT` the page can
 * read before the page gives up on its own. Mirrors `vendor.media`.
 */
const PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const PERMISSION_HOST_TIMEOUT_MS = PERMISSION_REQUEST_TIMEOUT_MS - 5_000;

export const permissionSpecs = {
  request: {
    pluginId: 'core.permissions',
    name: 'permissions.request',
    args: {} as { permission: PermissionId },
    result: {} as PermissionResult,
    hostTimeoutMs: PERMISSION_HOST_TIMEOUT_MS,
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
      return invokeEvent(
        permissionSpecs.request,
        { permission },
        null,
        PERMISSION_REQUEST_TIMEOUT_MS,
      );
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
