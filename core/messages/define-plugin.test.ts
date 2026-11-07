import { describe, expect, it, vi } from 'vite-plus/test';
import { createPluginRegistry, createPluginRouter } from './plugin-kernel';
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

  it('answers UNSUPPORTED_EVENT for an event with no invoke handler (D-11)', async () => {
    const plugin = definePlugin('core.test', specs, {
      invoke: {
        ping: (args) => {
          return [null, { message: String(args?.message ?? 'pong') }];
        },
      },
    });
    const invoke = plugin.runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');
    const [error] = await invoke('test.other', {}, context);
    expect(error?.code).toBe('UNSUPPORTED_EVENT');
  });

  it('omits the bare runtime when no handlers are supplied', () => {
    const plugin = definePlugin('core.test', specs);
    expect(plugin.runtimes.bare).toBeUndefined();
  });
});

describe('definePlugin hardening', () => {
  const twoSpecs = {
    pick: {
      pluginId: 'app.media',
      name: 'media.pick',
      args: {} as { kind?: 'image' | 'video' },
      result: {} as { url: string },
      validate: (args: unknown) => {
        const kind = (args as { kind?: unknown } | undefined)?.kind;
        return kind === undefined || kind === 'image' || kind === 'video';
      },
      hostTimeoutMs: 300_000,
    },
    other: {
      pluginId: 'app.media',
      name: 'media.other',
      args: {} as Record<string, never>,
      result: {} as unknown,
    },
  } as const;

  it('routes a declared event with no handler to UNSUPPORTED_EVENT, not PLUGIN_ERROR (D-11)', async () => {
    const registry = createPluginRegistry();
    registry.register(
      definePlugin('app.media', twoSpecs, {
        invoke: { pick: () => [null, { url: 'u' }] },
        dispatch: { pick: () => {} },
      }),
    );
    const router = createPluginRouter(registry, 'bare', {
      logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    for (const type of ['INVOKE_REQUEST', 'DISPATCH'] as const) {
      const response = await router.route(
        { type, pluginId: 'app.media', event: 'media.other', requestId: 'r' },
        new Uint8Array(0),
      );
      expect(response?.error?.code).toBe('UNSUPPORTED_EVENT');
    }
  });

  it('runs the spec validator before the handler (D-4)', async () => {
    const handler = vi.fn(
      () => [null, { url: 'u' }] as [null, { url: string }],
    );
    const plugin = definePlugin('app.media', twoSpecs, {
      invoke: { pick: handler },
    });
    const invoke = plugin.runtimes.bare!.invoke!;
    const [error] = await invoke('media.pick', { kind: '../etc' }, context);
    expect(error?.code).toBe('PLUGIN_ERROR');
    expect(error?.message).toBe('Invalid arguments for app.media.media.pick');
    expect(handler).not.toHaveBeenCalled();
    expect(await invoke('media.pick', { kind: 'image' }, context)).toEqual([
      null,
      { url: 'u' },
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs the spec validator before a dispatch handler (D-4)', () => {
    const handler = vi.fn();
    const plugin = definePlugin('app.media', twoSpecs, {
      dispatch: { pick: handler },
    });
    const dispatch = plugin.runtimes.bare!.dispatch!;
    expect(() => dispatch('media.pick', { kind: 1 }, context)).toThrow(
      /Invalid arguments/,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('carries a per-event host timeout into the manifest (C-1)', () => {
    const plugin = definePlugin('app.media', twoSpecs);
    expect(plugin.hostTimeoutsMs?.['media.pick']).toBe(300_000);
    expect(plugin.hostTimeoutsMs?.['media.other']).toBeUndefined();
    expect(definePlugin('core.test', specs).hostTimeoutsMs).toBeUndefined();
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

describe('host timeout cap', () => {
  it('caps hostTimeoutMs at the setTimeout limit (adv-A-7)', () => {
    const plugin = definePlugin('app.slow', {
      e: {
        pluginId: 'app.slow',
        name: 'slow.e',
        args: {} as Record<string, never>,
        result: {} as unknown,
        hostTimeoutMs: 1e12,
      },
    } as const);
    expect(plugin.hostTimeoutsMs?.['slow.e']).toBe(2 ** 31 - 1);
  });
});
