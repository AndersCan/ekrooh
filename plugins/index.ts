import { PluginManifest } from '../core/messages';
import {
  createDiscoveryPlugin,
  type DiscoveryPluginDeps,
} from './discovery/plugin';
import { createHealthPlugin } from './health/plugin';
import { createLogsPlugin, type LogsPluginDeps } from './logs/plugin';
import { createMediaPlugin, type MediaPluginDeps } from './media/plugin';
import { createPermissionsPluginStub } from './permissions/plugin';

export type { DiscoveryPluginDeps } from './discovery/plugin';
export type { LogsPluginDeps } from './logs/plugin';
export type { MediaPluginDeps } from './media/plugin';

export type DefaultPluginsDeps = DiscoveryPluginDeps &
  MediaPluginDeps &
  LogsPluginDeps;

export function createDefaultPlugins(
  deps: DefaultPluginsDeps,
): PluginManifest[] {
  return [
    createHealthPlugin(),
    createDiscoveryPlugin(deps),
    createPermissionsPluginStub(),
    createMediaPlugin(deps),
    createLogsPlugin(deps),
  ];
}
