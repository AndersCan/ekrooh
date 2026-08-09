import { describe, expect, it } from 'vite-plus/test';
import { createHealthInvokeHandlers } from './mock-handlers';
import { createHealthPlugin } from '../../plugins/health/plugin';

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

    expect(mockResult).toEqual(pluginResult);
  });
});
