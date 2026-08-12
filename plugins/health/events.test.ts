import { describe, expect, it } from 'vite-plus/test';
import { healthEvents, healthSpecs } from './events';

describe('healthEvents builders', () => {
  it('ping defaults the message', () => {
    expect(healthEvents.health.ping()).toMatchObject({
      kind: 'invoke',
      pluginId: 'core.health',
      event: 'health.ping',
      args: { message: 'ping' },
    });
  });

  it('ping carries the given message', () => {
    expect(healthEvents.health.ping('hello').args).toEqual({
      message: 'hello',
    });
  });

  it('payloadEcho carries the label and raw payload', () => {
    const payload = new Uint8Array([1, 2, 3]);
    expect(healthEvents.health.payloadEcho('x', payload)).toMatchObject({
      event: 'health.payloadEcho',
      args: { label: 'x' },
      payload,
    });
  });

  it('roundtrip is a no-arg invoke', () => {
    expect(healthEvents.health.roundtrip()).toMatchObject({
      event: 'health.roundtrip',
      args: {},
    });
  });

  it('specs pin the wire event names', () => {
    expect(Object.values(healthSpecs).map((s) => s.name)).toEqual([
      'health.ping',
      'health.payloadEcho',
      'health.roundtrip',
    ]);
  });
});
