import type { PermissionId } from './events';

/** Canonical permission ids. Internal (not an `exports` entry): hosts keep
 * their own allowlists (Android `DefaultHostPlugins.kt`, iOS
 * `DefaultHostPlugins.swift`); the mock transport uses this one so an unknown
 * or missing id answers `unsupported` there too, never a fake grant. */
export const PERMISSION_IDS: readonly PermissionId[] = ['storage', 'camera'];

export function isPermissionId(value: unknown): value is PermissionId {
  return (PERMISSION_IDS as readonly unknown[]).includes(value);
}
