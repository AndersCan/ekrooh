import { EventSpec, invokeEvent, InvokeEnvelope } from '../../core/messages';

export const healthSpecs = {
  ping: {
    pluginId: 'core.health',
    name: 'health.ping',
    args: {} as { message?: string },
    result: {} as { message: string; ts: number },
  },
  payloadEcho: {
    pluginId: 'core.health',
    name: 'health.payloadEcho',
    args: {} as { label: string },
    result: {} as { label: string; payloadSize: number },
  },
  roundtrip: {
    pluginId: 'core.health',
    name: 'health.roundtrip',
    args: {} as Record<string, never>,
    result: {} as { pong: true; ts: number },
  },
} as const satisfies Record<string, EventSpec<any, any>>;

export const healthEvents = {
  health: {
    ping(
      message = 'ping',
    ): InvokeEnvelope<
      'health.ping',
      { message?: string },
      { message: string; ts: number }
    > {
      return invokeEvent(healthSpecs.ping, { message });
    },
    payloadEcho(
      label: string,
      payload: Uint8Array | ArrayBuffer | string,
    ): InvokeEnvelope<
      'health.payloadEcho',
      { label: string },
      { label: string; payloadSize: number }
    > {
      return invokeEvent(healthSpecs.payloadEcho, { label }, payload);
    },
    roundtrip(): InvokeEnvelope<
      'health.roundtrip',
      Record<string, never>,
      { pong: true; ts: number }
    > {
      return invokeEvent(healthSpecs.roundtrip, {});
    },
  },
};
