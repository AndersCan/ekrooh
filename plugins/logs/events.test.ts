import { describe, expect, it } from 'vite-plus/test';
import { logEvents, logsSpecs } from './events';
import { createLogRingBuffer } from '../../core/logs/store';

describe('logEvents builders', () => {
  it('view builds a logs invoke envelope with options', () => {
    expect(logEvents.logs.view({ tail: 5, level: 'warn' })).toMatchObject({
      kind: 'invoke',
      pluginId: 'core.logs',
      event: 'logs.view',
      args: { tail: 5, level: 'warn' },
    });
  });

  it('view defaults to an empty options object', () => {
    expect(logEvents.logs.view()).toMatchObject({
      event: 'logs.view',
      args: {},
    });
  });

  it('clear builds the no-arg clear invoke', () => {
    expect(logEvents.logs.clear()).toMatchObject({
      kind: 'invoke',
      pluginId: 'core.logs',
      event: 'logs.clear',
      args: {},
    });
  });

  it('specs pin the wire event names', () => {
    expect(Object.values(logsSpecs).map((s) => s.name)).toEqual([
      'logs.view',
      'logs.clear',
    ]);
  });

  it('round-trips through a real ring buffer', () => {
    const store = createLogRingBuffer(10);
    store.append({ ts: 1, level: 'info', source: 'backend', message: 'a' });
    store.append({ ts: 2, level: 'warn', source: 'backend', message: 'b' });
    const args = logEvents.logs.view({ source: 'backend' }).args as {
      tail?: number;
      source?: string;
      level?: string;
    };
    expect(
      store.view({ source: args.source as 'backend' }).map((e) => e.message),
    ).toEqual(['a', 'b']);
  });
});
