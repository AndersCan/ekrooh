import { describe, expect, it } from 'vite-plus/test';
import { createLogsPlugin, LOGS_VIEW_MAX_TAIL } from './plugin';
import { LogsClearResult, LogsViewResult } from './events';
import { createLogRingBuffer } from '../../core/logs/store';
import {
  createPluginRegistry,
  createPluginRouter,
  type PluginContext,
} from '../../core/messages';

const context: PluginContext = { runtime: 'bare', payload: new Uint8Array(0) };

describe('createLogsPlugin', () => {
  const store = createLogRingBuffer(100);
  const plugin = createLogsPlugin({ store });
  const invoke = plugin.runtimes.bare?.invoke;
  if (!invoke) throw new Error('expected bare invoke adapter');

  function seed() {
    store.clear();
    for (let i = 0; i < 5; i++) {
      store.append({
        ts: i,
        level: i % 2 === 0 ? 'info' : 'warn',
        source: 'backend',
        message: `m${i}`,
      });
    }
    store.append({ ts: 6, level: 'error', source: 'web', message: 'web err' });
  }

  it('logs.view returns the bounded tail newest-last', async () => {
    seed();
    const [error, result] = await invoke('logs.view', { tail: 3 }, context);
    expect(error).toBeNull();
    expect((result as LogsViewResult).entries.map((e) => e.message)).toEqual([
      'm3',
      'm4',
      'web err',
    ]);
  });

  it('logs.view filters by level and source', async () => {
    seed();
    const [errLevel, warn] = await invoke(
      'logs.view',
      { level: 'warn' },
      context,
    );
    expect(errLevel).toBeNull();
    expect((warn as LogsViewResult).entries.map((e) => e.message)).toEqual([
      'm1',
      'm3',
    ]);

    const [, web] = await invoke('logs.view', { source: 'web' }, context);
    expect((web as LogsViewResult).entries.map((e) => e.message)).toEqual([
      'web err',
    ]);
  });

  it('logs.view enforces the framed header ceiling on tail', async () => {
    seed();
    const [error, result] = await invoke(
      'logs.view',
      { tail: LOGS_VIEW_MAX_TAIL + 100 },
      context,
    );
    expect(error).toBeNull();
    expect((result as LogsViewResult).entries.length).toBeLessThanOrEqual(
      LOGS_VIEW_MAX_TAIL,
    );
  });

  it('logs.clear empties the buffer and reports the count', async () => {
    seed();
    const [error, result] = await invoke('logs.clear', {}, context);
    expect(error).toBeNull();
    expect((result as LogsClearResult).cleared).toBe(6);
    expect(store.view().length).toBe(0);
  });

  it('assigns monotonic sequence numbers across sources', () => {
    const fresh = createLogRingBuffer(100);
    fresh.append({ ts: 1, level: 'info', source: 'backend', message: 'b' });
    fresh.append({ ts: 2, level: 'info', source: 'web', message: 'w' });
    const view = fresh.view();
    expect(view.map((e) => e.seq)).toEqual([0, 1]);
    expect(view[1]?.source).toBe('web');
  });

  it('declares its events and capabilities', () => {
    expect(plugin.id).toBe('core.logs');
    expect(plugin.events).toEqual(['logs.view', 'logs.clear']);
    expect(plugin.capabilities).toContain('logs');
  });

  it('rejects unsupported events deterministically via the router', async () => {
    const registry = createPluginRegistry();
    registry.register(createLogsPlugin({ store }));
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.logs',
        event: 'logs.bogus',
        requestId: 'r1',
      },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe('UNSUPPORTED_EVENT');
  });
});
