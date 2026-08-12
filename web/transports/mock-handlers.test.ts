import { describe, expect, it } from 'vite-plus/test';
import { createHealthInvokeHandlers } from './mock-handlers';

const handlers = createHealthInvokeHandlers();

describe('createHealthInvokeHandlers', () => {
  it('health.ping echoes the message with a default of pong', () => {
    expect(handlers['health.ping']({ message: 'yo' })).toMatchObject({
      message: 'yo',
    });
    expect(handlers['health.ping'](undefined)).toMatchObject({
      message: 'pong',
    });
  });

  it('health.payloadEcho measures the payload size', () => {
    expect(
      handlers['health.payloadEcho'](
        { label: 'bytes' },
        new Uint8Array([1, 2, 3]),
      ),
    ).toEqual({ label: 'bytes', payloadSize: 3 });
    expect(handlers['health.payloadEcho'](undefined, 'abc')).toMatchObject({
      label: 'payload',
      payloadSize: 3,
    });
    expect(
      handlers['health.payloadEcho'](undefined, new ArrayBuffer(2)),
    ).toMatchObject({
      payloadSize: 2,
    });
    expect(handlers['health.payloadEcho'](undefined, undefined)).toMatchObject({
      payloadSize: 0,
    });
  });

  it('health.roundtrip pongs', () => {
    expect(handlers['health.roundtrip'](undefined)).toEqual({
      pong: true,
      ts: expect.any(Number),
    });
  });
});
