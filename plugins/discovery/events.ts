import { InvokeEnvelope } from '../../core/messages';
import type { CapabilityDescriptor } from '../../core/messages/types';

export type DiscoveryListResult = {
  schemaVersion: 1;
  capabilities: CapabilityDescriptor[];
};

export const discoveryEvents = {
  discovery: {
    list(): InvokeEnvelope<
      'discovery.list',
      Record<string, never>,
      DiscoveryListResult
    > {
      return {
        kind: 'invoke',
        pluginId: 'core.discovery',
        event: 'discovery.list',
        args: {},
      };
    },
  },
};
