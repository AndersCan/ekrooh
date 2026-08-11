import { describe, expect, it } from 'vite-plus/test';
import { createHealthPlugin } from './plugin';
import {
  createPluginRegistry,
  createPluginRouter,
  type PluginContext,
} from '../../core/messages';

const context: PluginContext = { runtime: 'bare', payload: new Uint8Array(0) };

describe('createHealthPlugin', () => {
  const plugin = createHealthPlugin();
  const invoke = plugin.runtimes.bare?.invoke;
  if (!invoke) throw new Error('expected bare invoke adapter');

  it('answers health.ping with the given message', async () => {
    const [error, result] = await invoke(
      'health.ping',
      { message: 'hello' },
      context,
    );
    expect(error).toBeNull();
    expect(result).toEqual({ message: 'hello', ts: expect.any(Number) });
  });

  it('health.ping defaults to pong', async () => {
    const [, result] = await invoke('health.ping', undefined, context);
    expect(result).toEqual({ message: 'pong', ts: expect.any(Number) });
  });

  it('health.payloadEcho reports the payload size', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const [error, result] = await invoke(
      'health.payloadEcho',
      { label: 'bytes' },
      { runtime: 'bare', payload },
    );
    expect(error).toBeNull();
    expect(result).toEqual({ label: 'bytes', payloadSize: 4 });
  });

  it('health.roundtrip returns pong', async () => {
    const [error, result] = await invoke('health.roundtrip', {}, context);
    expect(error).toBeNull();
    expect(result).toEqual({ pong: true, ts: expect.any(Number) });
  });

  it('rejects unsupported events deterministically via the router', async () => {
    const registry = createPluginRegistry();
    registry.register(createHealthPlugin());
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.bogus',
        requestId: 'r1',
      },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe('UNSUPPORTED_EVENT');
    expect(response?.error?.message).toContain('health.bogus');
  });

  it('declares its events and capabilities', () => {
    expect(plugin.id).toBe('core.health');
    expect(plugin.events).toEqual([
      'health.ping',
      'health.payloadEcho',
      'health.roundtrip',
    ]);
    expect(plugin.capabilities).toContain('health');
  });
});
