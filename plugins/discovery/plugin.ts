import {
  CapabilityDescriptor,
  definePlugin,
  ok,
  PluginManifest,
  RuntimeTarget,
} from '../../core/messages';
import { discoverySpecs } from './events';

function mergeCapabilityRows(
  a: CapabilityDescriptor[],
  b: CapabilityDescriptor[],
): CapabilityDescriptor[] {
  const map = new Map<string, CapabilityDescriptor>();
  for (const row of [...a, ...b]) {
    const existing = map.get(row.pluginId);
    if (!existing) {
      map.set(row.pluginId, {
        pluginId: row.pluginId,
        capabilities: [...row.capabilities],
        events: [...row.events],
        runtimes: [...row.runtimes],
      });
    } else {
      const ev = new Set([...existing.events, ...row.events]);
      const rt = new Set<RuntimeTarget>([
        ...existing.runtimes,
        ...row.runtimes,
      ]);
      const caps = new Set([...existing.capabilities, ...row.capabilities]);
      map.set(row.pluginId, {
        pluginId: row.pluginId,
        capabilities: [...caps],
        events: [...ev],
        runtimes: [...rt],
      });
    }
  }
  return [...map.values()];
}

export type DiscoveryPluginDeps = {
  listBareCapabilities: () => Array<{
    pluginId: string;
    capabilities: string[];
    events: string[];
    runtimes: RuntimeTarget[];
  }>;
  queryHostCapabilities: () => Promise<CapabilityDescriptor[]>;
};

export function createDiscoveryPlugin(
  deps: DiscoveryPluginDeps,
): PluginManifest {
  return definePlugin('core.discovery', discoverySpecs, {
    capabilities: ['discovery'],
    invoke: {
      list: async () => {
        const bareRows = deps.listBareCapabilities();
        const hostRows = await deps.queryHostCapabilities();
        const merged = mergeCapabilityRows(bareRows, hostRows);
        return ok({ schemaVersion: 1 as const, capabilities: merged });
      },
    },
  });
}
