import { PluginManifest } from '../../core/messages';

/**
 * Declares host-only permission events. Handlers are registered on the Android host
 * via {@code HostPluginRegistry}; the worklet delegates invokes here over IPC.
 */
export function createPermissionsPluginStub(): PluginManifest {
  return {
    id: 'core.permissions',
    capabilities: ['permissions'],
    events: ['permissions.requestStorage'],
    runtimes: {},
  };
}
