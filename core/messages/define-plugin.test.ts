import { describe, expect, it } from 'vite-plus/test';
import { definePlugin, dispatchEvent, invokeEvent } from './define-plugin';

const specs = {
  ping: {
    pluginId: 'core.test',
    name: 'test.ping',
    args: {} as { message?: string },
    result: {} as { message: string },
  },
} as const;

const context = { runtime: 'bare' as const, payload: new Uint8Array(0) };

describe('definePlugin', () => {
  it('derives the events list from the spec table', () => {
    const plugin = definePlugin('core.test', specs);
    expect(plugin.id).toBe('core.test');
    expect(plugin.events).toEqual(['test.ping']);
  });

  it('rejects a spec that belongs to another plugin id', () => {
    expect(() => definePlugin('other.plugin', specs)).toThrow(
      /belongs to core.test, not other.plugin/,
    );
  });

  it('routes invoke events to the registered handler', async () => {
    const plugin = definePlugin('core.test', specs, {
      invoke: {
        ping: (args) => {
          return [null, { message: String(args?.message ?? 'pong') }];
        },
      },
    });
    const invoke = plugin.runtimes.bare?.invoke;
    expect(invoke).toBeDefined();
    const result = await invoke!('test.ping', { message: 'hi' }, context);
    expect(result).toEqual([null, { message: 'hi' }]);
  });

  it('throws on unhandled invoke events', () => {
    const plugin = definePlugin('core.test', specs, {
      invoke: {
        ping: (args) => {
          return [null, { message: String(args?.message ?? 'pong') }];
        },
      },
    });
    const invoke = plugin.runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');
    expect(() => invoke('test.other', {}, context)).toThrow(
      /Unhandled invoke event test.other/,
    );
  });

  it('omits the bare runtime when no handlers are supplied', () => {
    const plugin = definePlugin('core.test', specs);
    expect(plugin.runtimes.bare).toBeUndefined();
  });
});

describe('typed event builders', () => {
  it('invokeEvent builds an invoke envelope', () => {
    const payload = new Uint8Array([1, 2]);
    expect(
      invokeEvent(specs.ping, { message: 'hello' }, payload, 5000),
    ).toEqual({
      kind: 'invoke',
      pluginId: 'core.test',
      event: 'test.ping',
      args: { message: 'hello' },
      payload,
      timeoutMs: 5000,
    });
  });

  it('invokeEvent omits optional payload and timeout', () => {
    expect(invokeEvent(specs.ping, {})).toEqual({
      kind: 'invoke',
      pluginId: 'core.test',
      event: 'test.ping',
      args: {},
      payload: undefined,
      timeoutMs: undefined,
    });
  });

  it('dispatchEvent builds a dispatch envelope', () => {
    expect(dispatchEvent(specs.ping, {})).toEqual({
      kind: 'dispatch',
      pluginId: 'core.test',
      event: 'test.ping',
      args: {},
      payload: undefined,
    });
  });
});
