import { PluginManifest } from '../core/messages';
import {
  createDiscoveryPlugin,
  type DiscoveryPluginDeps,
} from './discovery/plugin';
import { createHealthPlugin } from './health/plugin';
import { createPermissionsPluginStub } from './permissions/plugin';

export type { DiscoveryPluginDeps } from './discovery/plugin';

export function createDefaultPlugins(
  deps: DiscoveryPluginDeps,
): PluginManifest[] {
  return [
    createHealthPlugin(),
    createDiscoveryPlugin(deps),
    createPermissionsPluginStub(),
  ];
}
