import { describe, expect, it } from 'vite-plus/test';
import { createMockTransport } from './mock';
import {
  MessageType,
  type CapabilityDescriptor,
  type PluginInvokeResponseHeader,
} from '../../core/messages';
import { createDefaultPlugins } from '../../plugins';
import { createPluginRegistry } from '../../core/messages';
import { createLogRingBuffer } from '../../core/logs/store';

/** One invoke through the mock, resolved with its response header. */
function call(
  pluginId: string,
  event: string,
  args?: Record<string, unknown>,
  payload: Uint8Array | string | null = null,
): Promise<PluginInvokeResponseHeader> {
  const transport = createMockTransport();
  return new Promise((resolve) => {
    transport.subscribe((m) => resolve(m.header as PluginInvokeResponseHeader));
    transport.send(
      MessageType.ENVELOPE,
      { type: 'INVOKE_REQUEST', pluginId, event, requestId: 'r', args },
      payload,
    );
  });
}

/** The worklet's own plugin list, as `createWorkletRuntime` registers it. */
function realWorkletPlugins() {
  const registry = createPluginRegistry();
  for (const plugin of createDefaultPlugins({
    listBareCapabilities: () => registry.listCapabilities(),
    queryHostCapabilities: async () => [],
    staticServer: {} as never,
    invokeOnHost: async () => null,
    store: createLogRingBuffer(10),
  })) {
    registry.register(plugin);
  }
  return registry;
}

describe('mock transport parity with the real worklet (D-8)', () => {
  it('discovery lists every plugin the real worklet registers, core.logs included', async () => {
    const real = realWorkletPlugins();
    const header = await call('core.discovery', 'discovery.list', {});
    const rows = (header.result as { capabilities: CapabilityDescriptor[] })
      .capabilities;
    const mockIds = rows.map((r) => r.pluginId).sort();
    const realIds = real
      .listCapabilities()
      .map((r) => r.pluginId)
      .concat('core.permissions')
      .filter((id, i, all) => all.indexOf(id) === i)
      .sort();
    expect(mockIds).toEqual(realIds);
    expect(mockIds).toContain('core.logs');
    for (const row of rows) {
      expect(row.events.sort()).toEqual(
        (real.get(row.pluginId)?.events ?? []).slice().sort(),
      );
    }
  });

  it('permissions: a known id is answered, an unknown or missing id is unsupported (D-12)', async () => {
    const camera = await call('core.permissions', 'permissions.request', {
      permission: 'camera',
    });
    expect(camera.result).toEqual({ permission: 'camera', status: 'granted' });

    const location = await call('core.permissions', 'permissions.request', {
      permission: 'location',
    });
    expect(location.result).toEqual({
      permission: 'location',
      status: 'unsupported',
    });

    const missing = await call('core.permissions', 'permissions.status', {});
    expect(missing.result).toEqual({ permission: '', status: 'unsupported' });

    const bogus = await call('core.permissions', 'permissions.status', {
      permission: 42,
    });
    expect(bogus.result).toEqual({ permission: '', status: 'unsupported' });
  });

  it('media: an unknown kind is rejected like the real plugin', async () => {
    const bad = await call('vendor.media', 'media.pick', { kind: '../etc' });
    expect(bad.error?.code).toBe('PLUGIN_ERROR');
    expect(bad.result).toBeUndefined();

    const good = await call('vendor.media', 'media.capture', {
      kind: 'video',
    });
    expect(good.error).toBeUndefined();
    expect((good.result as { url: string }).url).toMatch(/^data:image\//);
  });

  it('routes by pluginId as well as event name', async () => {
    const header = await call('app.anything', 'health.ping', {});
    expect(header.error?.code).toBe('UNSUPPORTED_EVENT');
  });

  it('logs.view rejects a non-number tail like the real plugin', async () => {
    const header = await call('core.logs', 'logs.view', { tail: 'all' });
    expect(header.error?.code).toBe('PLUGIN_ERROR');
  });

  it('health.payloadEcho measures the payload like the real plugin', async () => {
    const bytes = await call(
      'core.health',
      'health.payloadEcho',
      { label: 'b' },
      new Uint8Array([1, 2, 3]),
    );
    expect(bytes.result).toEqual({ label: 'b', payloadSize: 3 });
    const text = await call(
      'core.health',
      'health.payloadEcho',
      { label: 't' },
      'abc',
    );
    expect(text.result).toEqual({ label: 't', payloadSize: 3 });
  });
});
