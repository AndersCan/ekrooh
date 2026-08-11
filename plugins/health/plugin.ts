import { definePlugin, ok, PluginManifest } from '../../core/messages';
import { healthSpecs } from './events';

export function createHealthPlugin(): PluginManifest {
  return definePlugin('core.health', healthSpecs, {
    capabilities: ['health'],
    invoke: {
      ping: (args) => ok({ message: args?.message ?? 'pong', ts: Date.now() }),
      payloadEcho: (args, context) =>
        ok({
          label: args?.label ?? 'payload',
          payloadSize: context.payload.byteLength,
        }),
      roundtrip: () => ok({ pong: true as const, ts: Date.now() }),
    },
  });
}
