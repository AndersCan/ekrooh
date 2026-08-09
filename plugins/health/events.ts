import { InvokeEnvelope } from '../../core/messages';

export const healthEvents = {
  health: {
    ping(
      message = 'ping',
    ): InvokeEnvelope<
      'health.ping',
      { message: string },
      { message: string; ts: number }
    > {
      return {
        kind: 'invoke',
        pluginId: 'core.health',
        event: 'health.ping',
        args: { message },
      };
    },
    payloadEcho(
      label: string,
      payload: Uint8Array | ArrayBuffer | string,
    ): InvokeEnvelope<
      'health.payloadEcho',
      { label: string },
      { label: string; payloadSize: number }
    > {
      return {
        kind: 'invoke',
        pluginId: 'core.health',
        event: 'health.payloadEcho',
        args: { label },
        payload,
      };
    },
    roundtrip(): InvokeEnvelope<
      'health.roundtrip',
      Record<string, never>,
      { pong: true; ts: number }
    > {
      return {
        kind: 'invoke',
        pluginId: 'core.health',
        event: 'health.roundtrip',
        args: {},
      };
    },
  },
};
