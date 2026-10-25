import { describe, expect, it } from 'vite-plus/test';
import {
  createPluginRegistry,
  createPluginRouter,
  definePlugin,
  ok,
  type EventSpec,
} from './core/messages';
import { healthEvents } from './plugins/health/events';
import { createHealthPlugin } from './plugins/health/plugin';

// Executable examples for docs/api-charter.md. If one fails, either the API
// drifted from the charter or the charter needs an owner-approved edit.

describe('charter: callers use typed event builders, never raw frames', () => {
  it('builds an invoke envelope from a one-line call', () => {
    const envelope = healthEvents.health.ping('hi');
    expect(envelope).toMatchObject({
      kind: 'invoke',
      pluginId: 'core.health',
      event: 'health.ping',
    });
  });
});

describe('charter: a plugin is its specs plus handlers, declared once', () => {
  const specs = {
    greet: {
      pluginId: 'demo.greeter',
      name: 'greet.hello',
      args: {} as { name: string },
      result: {} as { text: string },
    },
  } as const satisfies Record<string, EventSpec<any, any>>;

  it('declares id, capabilities and handlers in one definePlugin call', async () => {
    const plugin = definePlugin('demo.greeter', specs, {
      capabilities: ['greet'],
      invoke: { greet: (args) => ok({ text: `hello ${args.name}` }) },
    });
    const invoke = plugin.runtimes.bare?.invoke;
    if (!invoke) throw new Error('expected bare invoke adapter');
    const [error, result] = await invoke(
      'greet.hello',
      { name: 'ada' },
      { runtime: 'bare', payload: new Uint8Array(0) },
    );
    expect(error).toBeNull();
    expect(result).toEqual({ text: 'hello ada' });
  });
});

describe('charter: unsupported behavior fails deterministically', () => {
  it('answers an unknown event with UNSUPPORTED_EVENT, not a throw or a hang', async () => {
    const registry = createPluginRegistry();
    registry.register(createHealthPlugin());
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.nope',
        requestId: 'r1',
      },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe('UNSUPPORTED_EVENT');
  });
});
