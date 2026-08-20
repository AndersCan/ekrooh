import { describe, expect, it } from 'vite-plus/test';
import {
  createHealthInvokeHandlers,
  createLogsInvokeHandlers,
} from './mock-handlers';
import { createHealthPlugin } from '../../plugins/health/plugin';
import { createLogsPlugin } from '../../plugins/logs/plugin';
import { createLogRingBuffer } from '../../core/logs/store';

describe('mock-handlers parity with the health plugin', () => {
  it('covers exactly the events the health plugin declares', () => {
    const mockKeys = Object.keys(createHealthInvokeHandlers()).sort();
    const plugin = createHealthPlugin();
    const pluginEvents = (plugin.events ?? []).sort();

    expect(mockKeys).toEqual(pluginEvents);
  });

  it('mocks match the plugin output shape for health.ping', async () => {
    const invoke = createHealthPlugin().runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');

    const [, pluginResult] = await invoke(
      'health.ping',
      { message: 'hi' },
      { runtime: 'bare', payload: new Uint8Array(0) },
    );
    const mockResult = createHealthInvokeHandlers()['health.ping']({
      message: 'hi',
    });

    // Same shape and values; `ts` may differ by a millisecond because the mock
    // and plugin call `Date.now()` at slightly different instants.
    const plugin = pluginResult as { message: string; ts: number };
    const mock = mockResult as { message: string; ts: number };
    expect(Object.keys(mock).sort()).toEqual(Object.keys(plugin).sort());
    expect(mock.message).toBe(plugin.message);
    expect(Math.abs(mock.ts - plugin.ts)).toBeLessThanOrEqual(1);
  });
});

describe('mock-handlers parity with the logs plugin', () => {
  it('covers exactly the events the logs plugin declares', () => {
    const mockKeys = Object.keys(createLogsInvokeHandlers()).sort();
    const plugin = createLogsPlugin({ store: createLogRingBuffer(100) });
    const pluginEvents = (plugin.events ?? []).sort();
    expect(mockKeys).toEqual(pluginEvents);
  });

  it('logs.clear matches the plugin output shape and value', async () => {
    const invoke = createLogsPlugin({
      store: createLogRingBuffer(100),
    }).runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');

    const [, pluginResult] = await invoke(
      'logs.clear',
      {},
      { runtime: 'bare', payload: new Uint8Array(0) },
    );
    const mockResult = createLogsInvokeHandlers()['logs.clear'](undefined);
    expect(pluginResult).toEqual(mockResult);
  });
});
