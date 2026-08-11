import { EventSpec, invokeEvent } from '../../core/messages';
import type { CapabilityDescriptor } from '../../core/messages/types';

export type DiscoveryListResult = {
  schemaVersion: 1;
  capabilities: CapabilityDescriptor[];
};

export const discoverySpecs = {
  list: {
    pluginId: 'core.discovery',
    name: 'discovery.list',
    args: {} as Record<string, never>,
    result: {} as DiscoveryListResult,
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const discoveryEvents = {
  discovery: {
    list() {
      return invokeEvent(discoverySpecs.list, {});
    },
  },
};
