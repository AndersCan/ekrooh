import { definePlugin, PluginManifest } from '../../core/messages';
import { permissionSpecs } from './events';

/**
 * Declares host-only permission events. Handlers are registered on the Android host
 * via {@code HostPluginRegistry}; the worklet delegates invokes here over IPC.
 */
export function createPermissionsPluginStub(): PluginManifest {
  return definePlugin('core.permissions', permissionSpecs, {
    capabilities: ['permissions'],
  });
}
