import { describe, expect, it } from 'vite-plus/test';
import {
  createHealthInvokeHandlers,
  createLogsInvokeHandlers,
} from './mock-handlers';
import { createLogRingBuffer } from '../../core/logs/store';

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

describe('createLogsInvokeHandlers', () => {
  it('logs.view returns an empty tail on a fresh store', () => {
    const logHandlers = createLogsInvokeHandlers();
    const result = logHandlers['logs.view']({ tail: 10 }) as {
      entries: Array<{ seq: number }>;
    };
    expect(result.entries).toEqual([]);
  });

  it('logs.clear empties the store and reports the count', () => {
    const store = createLogRingBuffer(100);
    store.append({ ts: 1, level: 'info', source: 'web', message: 'x' });
    const logHandlers = createLogsInvokeHandlers(store);
    expect(logHandlers['logs.clear'](undefined)).toEqual({ cleared: 1 });
    expect(logHandlers['logs.view'](undefined)).toEqual({ entries: [] });
  });

  it('logs.view filters by level and source', () => {
    const store = createLogRingBuffer(100);
    store.append({ ts: 1, level: 'info', source: 'web', message: 'web' });
    store.append({ ts: 2, level: 'warn', source: 'backend', message: 'back' });
    const logHandlers = createLogsInvokeHandlers(store);
    const web = logHandlers['logs.view']({ source: 'web' }) as {
      entries: Array<{ message: string }>;
    };
    expect(web.entries.map((e) => e.message)).toEqual(['web']);
    const warn = logHandlers['logs.view']({ level: 'warn' }) as {
      entries: Array<{ message: string }>;
    };
    expect(warn.entries.map((e) => e.message)).toEqual(['back']);
  });
});
