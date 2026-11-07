import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { ErrorCode } from './constants';
import { CoreError } from './types';
import {
  createPluginBus,
  createPluginRegistry,
  createPluginRouter,
} from './plugin-kernel';
import { MessageType } from './constants';
import { MessageProtocol } from './wire-codec';
import {
  createProtocolMessenger,
  type InvokeRequest,
  type ProtocolMessenger,
} from './rpc-messenger';
import type { MessageHeader, PluginInvokeResponseHeader } from './types';

function ok<T>(result: T): [null, T] {
  return [null, result];
}

function err(code: string, message: string): [CoreError, null] {
  return [new CoreError(code, message), null];
}

describe('createPluginRegistry', () => {
  it('requires a namespaced plugin id', () => {
    const registry = createPluginRegistry();
    expect(() => registry.register({ id: 'nonspaced', runtimes: {} })).toThrow(
      /namespaced/,
    );
  });

  it('rejects duplicate plugin ids', () => {
    const registry = createPluginRegistry();
    registry.register({ id: 'app.plugin', runtimes: {} });
    expect(() => registry.register({ id: 'app.plugin', runtimes: {} })).toThrow(
      /already registered/,
    );
  });

  it('lists capabilities and resolves runtimes', () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      capabilities: ['health'],
      events: ['health.ping'],
      runtimes: {
        bare: { invoke: () => ok({}) },
      },
    });

    expect(registry.listCapabilities()).toEqual([
      {
        pluginId: 'core.health',
        capabilities: ['health'],
        events: ['health.ping'],
        runtimes: ['bare'],
      },
    ]);
    expect(registry.resolve('core.health', 'bare')).toBeDefined();
    expect(registry.resolve('core.health', 'android')).toBeUndefined();
    expect(registry.resolve('missing.plugin', 'bare')).toBeUndefined();
  });

  it('filters capability listing by runtime', () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      runtimes: { bare: { invoke: () => ok({}) } },
    });
    registry.register({
      id: 'app.other',
      runtimes: { android: { invoke: () => ok({}) } },
    });
    const rows = registry.listCapabilities('bare');
    expect(rows.map((r) => r.pluginId)).toEqual(['core.health']);
  });
});

describe('createPluginRouter', () => {
  it('routes a dispatch to the adapter', async () => {
    const registry = createPluginRegistry();
    const dispatch = vi.fn(async () => {});
    registry.register({
      id: 'core.health',
      events: ['health.ping'],
      runtimes: { bare: { dispatch } },
    });
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'DISPATCH',
        pluginId: 'core.health',
        event: 'health.ping',
        args: { message: 'hi' },
      },
      new Uint8Array(0),
    );
    expect(response).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      'health.ping',
      { message: 'hi' },
      expect.anything(),
    );
  });

  it('returns an error response when a dispatch has no adapter', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      events: ['health.ping'],
      runtimes: {},
    });
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      new Uint8Array(0),
    );
    expect(response?.type).toBe('INVOKE_RESPONSE');
    expect(response?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('routes an invoke to the adapter and returns the result', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      events: ['health.ping'],
      runtimes: {
        bare: {
          invoke: () => ok({ message: 'pong' }),
        },
      },
    });
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'r1',
      },
      new Uint8Array(0),
    );
    expect(response).toEqual({
      type: 'INVOKE_RESPONSE',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'r1',
      result: { message: 'pong' },
      error: undefined,
    });
  });

  it('maps adapter errors into INVOKE_RESPONSE error headers', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      events: ['health.bogus'],
      runtimes: {
        bare: {
          invoke: () => err('UNSUPPORTED_EVENT', 'nope'),
        },
      },
    });
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.bogus',
        requestId: 'r2',
      },
      new Uint8Array(0),
    );
    expect(response?.error).toEqual({
      code: 'UNSUPPORTED_EVENT',
      message: 'nope',
    });
  });

  it('synthesizes UNSUPPORTED_EVENT for events not declared in the manifest', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      events: ['health.ping'],
      runtimes: { bare: { invoke: () => ok({ message: 'pong' }) } },
    });
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.bogus',
        requestId: 'r6',
      },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe(ErrorCode.UNSUPPORTED_EVENT);
    expect(response?.error?.message).toContain('health.bogus');
  });

  it('wraps adapter exceptions as PLUGIN_ERROR', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      events: ['health.bogus'],
      runtimes: {
        bare: {
          invoke: () => {
            throw new Error('adapter exploded');
          },
        },
      },
    });
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.bogus',
        requestId: 'r7',
      },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe(ErrorCode.PLUGIN_ERROR);
    // The exception text stays in the log; the page gets a fixed message.
    expect(response?.error?.message).toBe('core.health.health.bogus failed');
  });

  it('wraps dispatch exceptions as PLUGIN_ERROR and logs them', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      events: ['health.ping'],
      runtimes: {
        bare: {
          dispatch: () => {
            throw new Error('dispatch exploded');
          },
        },
      },
    });
    const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const router = createPluginRouter(registry, 'bare', { logger });
    const response = await router.route(
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe(ErrorCode.PLUGIN_ERROR);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('dispatch exploded'),
    );
  });

  it('delegates to the host when no adapter exists (declared + host-registered)', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.permissions',
      events: ['permissions.requestStorage'],
      runtimes: {},
    });
    const delegated: PluginInvokeResponseHeader = {
      type: 'INVOKE_RESPONSE',
      pluginId: 'core.permissions',
      event: 'permissions.requestStorage',
      requestId: 'r3',
      result: { granted: true },
    };
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost: async () => delegated,
      getHostCapabilities: async () => [
        {
          pluginId: 'core.permissions',
          capabilities: ['permissions'],
          events: ['permissions.requestStorage'],
          runtimes: ['android'],
        },
      ],
    });
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'r3',
      },
      new Uint8Array(0),
    );
    expect(response).toEqual(delegated);
  });

  it('answers HOST_ERROR when the host capabilities query fails (ekrooh#268)', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'vendor.media',
      events: ['media.pickMany'],
      runtimes: {},
    });
    const delegateToHost = vi.fn(async () => null);
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost,
      getHostCapabilities: async () => {
        throw new Error('no CSPRNG');
      },
    });
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'vendor.media',
        event: 'media.pickMany',
        requestId: 'r-caps',
      },
      new Uint8Array(0),
    );
    expect(response).toEqual({
      type: 'INVOKE_RESPONSE',
      pluginId: 'vendor.media',
      event: 'media.pickMany',
      requestId: 'r-caps',
      error: {
        code: 'HOST_ERROR',
        message: 'vendor.media.media.pickMany failed',
      },
    });
    expect(delegateToHost).not.toHaveBeenCalled();
  });

  it('does NOT delegate a declared event the host has not registered', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.permissions',
      events: ['permissions.requestStorage'],
      runtimes: {},
    });
    const delegateToHost = vi.fn(async () => null);
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost,
      getHostCapabilities: async () => [
        {
          pluginId: 'core.permissions',
          capabilities: ['permissions'],
          events: ['permissions.status'],
          runtimes: ['android'],
        },
      ],
    });
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'r8',
      },
      new Uint8Array(0),
    );
    expect(delegateToHost).not.toHaveBeenCalled();
    expect(response?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('rejects an undeclared plugin/event and does NOT forward it to the host', async () => {
    const registry = createPluginRegistry();
    const delegateToHost = vi.fn(async () => null);
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost,
      getHostCapabilities: async () => [
        {
          pluginId: 'attacker.plugin',
          capabilities: [],
          events: ['evil.run'],
          runtimes: ['android'],
        },
      ],
    });
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'attacker.plugin',
        event: 'evil.run',
        requestId: 'r9',
      },
      new Uint8Array(0),
    );
    expect(delegateToHost).not.toHaveBeenCalled();
    expect(response?.error?.code).toBe(ErrorCode.UNSUPPORTED_EVENT);
  });

  it('rejects an undeclared event even when the host announces the plugin', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.permissions',
      events: ['permissions.requestStorage'],
      runtimes: {},
    });
    const delegateToHost = vi.fn(async () => null);
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost,
      getHostCapabilities: async () => [
        {
          pluginId: 'core.permissions',
          capabilities: ['permissions'],
          events: ['permissions.requestStorage'],
          runtimes: ['android'],
        },
      ],
    });
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.steal',
        requestId: 'r10',
      },
      new Uint8Array(0),
    );
    expect(delegateToHost).not.toHaveBeenCalled();
    expect(response?.error?.code).toBe(ErrorCode.UNSUPPORTED_EVENT);
  });

  it('honors capabilities the host adds/withdraws after the first delegated invoke', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.permissions',
      events: ['permissions.requestStorage', 'permissions.requestCamera'],
      runtimes: {},
    });
    const delegated: PluginInvokeResponseHeader = {
      type: 'INVOKE_RESPONSE',
      pluginId: 'core.permissions',
      event: 'permissions.requestStorage',
      requestId: 'r11',
      result: { granted: true },
    };
    const delegateToHost = vi.fn(
      async (header: {
        pluginId: string;
        event: string;
        requestId?: string;
      }): Promise<PluginInvokeResponseHeader> => ({
        type: 'INVOKE_RESPONSE',
        pluginId: header.pluginId,
        event: header.event,
        requestId: header.requestId,
        result: { granted: true },
      }),
    );
    const announce = (events: string[]) => [
      {
        pluginId: 'core.permissions',
        capabilities: ['permissions'],
        events,
        runtimes: ['android'],
      },
    ];
    // The host announces nothing first, then storage, then only camera —
    // a memoized snapshot would deny the newly-announced capability and keep
    // delegating the withdrawn one. Caching is switched off (`ttl 0`) so the
    // host is asked on every delegation; the cached behaviour has its own
    // tests below.
    const getHostCapabilities = vi
      .fn()
      .mockResolvedValueOnce(announce([]))
      .mockResolvedValueOnce(announce(['permissions.requestStorage']))
      .mockResolvedValue(announce(['permissions.requestCamera']));
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost,
      getHostCapabilities,
      hostCapabilitiesTtlMs: 0,
    });
    const invoke = (event: string, requestId: string) =>
      router.route(
        {
          type: 'INVOKE_REQUEST',
          pluginId: 'core.permissions',
          event,
          requestId,
        },
        new Uint8Array(0),
      );

    const denied = await invoke('permissions.requestStorage', 'r11');
    expect(denied?.error?.code).toBe('UNSUPPORTED_CAPABILITY');

    const granted = await invoke('permissions.requestStorage', 'r11');
    expect(granted).toEqual(delegated);

    const camera = await invoke('permissions.requestCamera', 'r12');
    expect(camera).toEqual({
      ...delegated,
      event: 'permissions.requestCamera',
      requestId: 'r12',
    });

    const withdrawn = await invoke('permissions.requestStorage', 'r13');
    expect(withdrawn?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(getHostCapabilities).toHaveBeenCalledTimes(4);
  });

  describe('host capabilities cache', () => {
    const announce = (events: string[]) => [
      {
        pluginId: 'core.permissions',
        capabilities: ['permissions'],
        events,
        runtimes: ['android' as const],
      },
    ];

    function setup(
      getHostCapabilities: () => Promise<ReturnType<typeof announce>>,
      delegateImpl?: () => Promise<PluginInvokeResponseHeader | null>,
    ) {
      const registry = createPluginRegistry();
      registry.register({
        id: 'core.permissions',
        events: ['permissions.requestStorage', 'permissions.requestCamera'],
        runtimes: {},
      });
      const delegateToHost = vi.fn(
        delegateImpl ??
          (async (header: {
            pluginId: string;
            event: string;
            requestId?: string;
          }) => ({
            type: 'INVOKE_RESPONSE' as const,
            pluginId: header.pluginId,
            event: header.event,
            requestId: header.requestId,
            result: { granted: true },
          })),
      );
      const queries = vi.fn(getHostCapabilities);
      const router = createPluginRouter(registry, 'bare', {
        delegateToHost: delegateToHost as never,
        getHostCapabilities: queries,
      });
      const invoke = (event = 'permissions.requestStorage') =>
        router.route(
          {
            type: 'INVOKE_REQUEST',
            pluginId: 'core.permissions',
            event,
            requestId: 'r',
          },
          new Uint8Array(0),
        );
      return { invoke, queries, delegateToHost };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('asks the host once for many delegated invokes', async () => {
      const { invoke, queries } = setup(async () =>
        announce(['permissions.requestStorage']),
      );
      for (let i = 0; i < 5; i++) {
        expect((await invoke())?.error).toBeUndefined();
      }
      expect(queries).toHaveBeenCalledTimes(1);
    });

    it('shares one query between concurrent cold-start invokes', async () => {
      const { invoke, queries } = setup(async () =>
        announce(['permissions.requestStorage']),
      );
      const results = await Promise.all(
        Array.from({ length: 10 }, () => invoke()),
      );
      expect(results.every((r) => r?.error === undefined)).toBe(true);
      expect(queries).toHaveBeenCalledTimes(1);
    });

    it('asks again once the TTL has expired', async () => {
      vi.useFakeTimers();
      const { invoke, queries } = setup(async () =>
        announce(['permissions.requestStorage']),
      );
      await invoke();
      await vi.advanceTimersByTimeAsync(29_000);
      await invoke();
      expect(queries).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await invoke();
      expect(queries).toHaveBeenCalledTimes(2);
    });

    it('does not re-query for an unlisted event inside the refresh window, then picks up a late announcement', async () => {
      vi.useFakeTimers();
      let events: string[] = [];
      const { invoke, queries } = setup(async () => announce(events));
      expect((await invoke())?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect((await invoke())?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(queries).toHaveBeenCalledTimes(1);

      // The host announces the capability; after the refresh window the next
      // call sees it.
      events = ['permissions.requestStorage'];
      await vi.advanceTimersByTimeAsync(2_001);
      expect((await invoke())?.error).toBeUndefined();
      expect(queries).toHaveBeenCalledTimes(2);
    });

    it('drops the cache when a delegation throws', async () => {
      let calls = 0;
      const { invoke, queries } = setup(
        async () => announce(['permissions.requestStorage']),
        async () => {
          calls++;
          if (calls === 1) throw new Error('host went away');
          return {
            type: 'INVOKE_RESPONSE',
            pluginId: 'core.permissions',
            event: 'permissions.requestStorage',
            requestId: 'r',
            result: { granted: true },
          };
        },
      );
      expect((await invoke())?.error?.code).toBe('HOST_ERROR');
      expect((await invoke())?.error).toBeUndefined();
      expect(queries).toHaveBeenCalledTimes(2);
    });

    it('drops the cache when the host disowns the event', async () => {
      let answered = false;
      const { invoke, queries } = setup(
        async () => announce(['permissions.requestStorage']),
        async () => {
          const unsupported = !answered;
          answered = true;
          return {
            type: 'INVOKE_RESPONSE',
            pluginId: 'core.permissions',
            event: 'permissions.requestStorage',
            requestId: 'r',
            ...(unsupported
              ? { error: { code: 'UNSUPPORTED_CAPABILITY', message: 'gone' } }
              : { result: { granted: true } }),
          };
        },
      );
      expect((await invoke())?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect((await invoke())?.error).toBeUndefined();
      expect(queries).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed query', async () => {
      let attempt = 0;
      const { invoke, queries } = setup(async () => {
        attempt++;
        if (attempt === 1) throw new Error('Host IPC timeout');
        return announce(['permissions.requestStorage']);
      });
      // The failure answers the caller (ekrooh#268) and is not cached.
      expect((await invoke())?.error).toEqual({
        code: 'HOST_ERROR',
        message: 'core.permissions.permissions.requestStorage failed',
      });
      expect((await invoke())?.error).toBeUndefined();
      expect(queries).toHaveBeenCalledTimes(2);
    });
  });

  it('returns UNSUPPORTED_CAPABILITY when neither adapter nor host handles it', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      events: ['health.ping'],
      runtimes: {},
    });
    const router = createPluginRouter(registry, 'bare');
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'r4',
      },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('returns HOST_ERROR when host delegation throws', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.permissions',
      events: ['permissions.requestStorage'],
      runtimes: {},
    });
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost: async () => {
        throw new Error('host exploded');
      },
      getHostCapabilities: async () => [
        {
          pluginId: 'core.permissions',
          capabilities: ['permissions'],
          events: ['permissions.requestStorage'],
          runtimes: ['android'],
        },
      ],
    });
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'r5',
      },
      new Uint8Array(0),
    );
    expect(response?.error?.code).toBe('HOST_ERROR');
    expect(response?.error?.message).toBe(
      'core.permissions.permissions.requestStorage failed',
    );
  });
});

describe('createPluginBus', () => {
  function fakeMessenger(
    respond: (request: InvokeRequest) => MessageHeader,
  ): ProtocolMessenger {
    return {
      dispatch: (request) => request.pluginId ?? 'id',
      invoke: async (request) => respond(request),
      handleIncoming: () => {},
    };
  }

  it('invoke resolves [null, result] on success', async () => {
    const bus = createPluginBus(
      fakeMessenger(() => ({
        type: 'INVOKE_RESPONSE',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'req-1',
        result: { message: 'pong' },
      })),
    );
    const [error, result] = await bus.invoke({
      kind: 'invoke',
      pluginId: 'core.health',
      event: 'health.ping',
      args: {},
    });
    expect(error).toBeNull();
    expect(result).toEqual({ message: 'pong' });
  });

  it('invoke maps error headers to a CoreError', async () => {
    const bus = createPluginBus(
      fakeMessenger(() => ({
        type: 'INVOKE_RESPONSE',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'req-2',
        error: { code: 'UNSUPPORTED_EVENT', message: 'nope' },
      })),
    );
    const [error, result] = await bus.invoke({
      kind: 'invoke',
      pluginId: 'core.health',
      event: 'health.ping',
      args: {},
    });
    expect(result).toBeNull();
    expect(error).toBeInstanceOf(CoreError);
    expect(error?.code).toBe('UNSUPPORTED_EVENT');
    expect(error?.message).toBe('nope');
  });

  it('preserves an app-scoped error code instead of flattening to PLUGIN_ERROR', async () => {
    const bus = createPluginBus(
      fakeMessenger(() => ({
        type: 'INVOKE_RESPONSE',
        pluginId: 'app.photos',
        event: 'photo.url',
        requestId: 'req-app',
        error: { code: 'app.photos/not-found', message: 'missing' },
      })),
    );
    const [error, result] = await bus.invoke({
      kind: 'invoke',
      pluginId: 'app.photos',
      event: 'photo.url',
      args: {},
    });
    expect(result).toBeNull();
    expect(error?.code).toBe('app.photos/not-found');
    expect(error?.message).toBe('missing');
  });

  it('forwards a present payload unchanged to the messenger (framed wire supports payloads)', async () => {
    const invoke = vi.fn<ProtocolMessenger['invoke']>(async () => ({
      type: 'INVOKE_RESPONSE',
      pluginId: 'core.health',
      event: 'health.payloadEcho',
      requestId: 'req-payload',
      result: { size: 3 },
    }));
    const messenger: ProtocolMessenger = {
      dispatch: () => 'id',
      invoke,
      handleIncoming: () => {},
    };
    const bus = createPluginBus(messenger);
    const payload = new Uint8Array([1, 2, 3]);
    const [error, result] = await bus.invoke({
      kind: 'invoke',
      pluginId: 'core.health',
      event: 'health.payloadEcho',
      args: {},
      payload,
    });
    expect(error).toBeNull();
    expect(result).toEqual({ size: 3 });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'INVOKE_REQUEST' }),
      payload,
      undefined,
    );
  });

  it('invoke rejects unexpected response types', async () => {
    const bus = createPluginBus(
      fakeMessenger(() => ({
        type: 'DISPATCH',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'req-3',
      })),
    );
    const [error] = await bus.invoke({
      kind: 'invoke',
      pluginId: 'core.health',
      event: 'health.ping',
      args: {},
    });
    expect(error?.code).toBe('INVALID_RESPONSE');
  });

  it('dispatch returns the request id assigned by the messenger', () => {
    const messenger = createProtocolMessenger(() => {});
    const bus = createPluginBus(messenger);
    const id = bus.dispatch({
      kind: 'dispatch',
      pluginId: 'core.health',
      event: 'health.ping',
      args: {},
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('maps a messenger timeout rejection into a TIMEOUT Either error', async () => {
    const messenger: ProtocolMessenger = {
      dispatch: () => 'req_1',
      invoke: () =>
        Promise.reject(new Error('invoke timeout for INVOKE_REQUEST (req_1)')),
      handleIncoming: () => {},
    };
    const bus = createPluginBus(messenger);

    const [error, result] = await bus.invoke({
      kind: 'invoke',
      pluginId: 'core.health',
      event: 'health.ping',
      args: {},
    });
    expect(result).toBeNull();
    expect(error?.code).toBe('TIMEOUT');
    expect(error?.message).toContain('invoke timeout');
  });

  it('maps other messenger rejections into INVALID_RESPONSE Either errors', async () => {
    const messenger: ProtocolMessenger = {
      dispatch: () => 'req_2',
      invoke: () =>
        Promise.reject(
          new Error('invoke dropped: too many concurrent invokes (req_2)'),
        ),
      handleIncoming: () => {},
    };
    const bus = createPluginBus(messenger);

    const [error, result] = await bus.invoke({
      kind: 'invoke',
      pluginId: 'core.health',
      event: 'health.ping',
      args: {},
    });
    expect(result).toBeNull();
    expect(error?.code).toBe('INVALID_RESPONSE');
  });
});

describe('integration: messenger + protocol + bus over an encoded channel', () => {
  it('performs an invoke round-trip through the wire codec', async () => {
    const protocol = new MessageProtocol();
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      events: ['health.ping'],
      runtimes: {
        bare: {
          invoke: () => ok({ message: 'pong', ts: 123 }),
        },
      },
    });
    const router = createPluginRouter(registry, 'bare');

    const sender = vi.fn(async (request: MessageHeader) => {
      const frame = protocol.encode(MessageType.ENVELOPE, request, null);
      const decoded = protocol.decode(frame);
      const response = await router.route(decoded.header, decoded.payload);
      if (response) {
        messenger.handleIncoming(response);
      }
    });

    const messenger = createProtocolMessenger(sender);
    const bus = createPluginBus(messenger);

    const [error, result] = await bus.invoke({
      kind: 'invoke',
      pluginId: 'core.health',
      event: 'health.ping',
      args: { message: 'hello' },
    });
    expect(error).toBeNull();
    expect(result).toEqual({ message: 'pong', ts: 123 });
  });

  it('round-trips an app-scoped error code end-to-end through the codec', async () => {
    const protocol = new MessageProtocol();
    const registry = createPluginRegistry();
    registry.register({
      id: 'app.photos',
      events: ['photo.url'],
      runtimes: {
        bare: {
          invoke: () => err('app.photos/not-found', 'missing'),
        },
      },
    });
    const router = createPluginRouter(registry, 'bare');

    const sender = vi.fn(async (request: MessageHeader) => {
      const frame = protocol.encode(MessageType.ENVELOPE, request, null);
      const decoded = protocol.decode(frame);
      const response = await router.route(decoded.header, decoded.payload);
      if (response) {
        messenger.handleIncoming(response);
      }
    });

    const messenger = createProtocolMessenger(sender);
    const bus = createPluginBus(messenger);

    const [error, result] = await bus.invoke({
      kind: 'invoke',
      pluginId: 'app.photos',
      event: 'photo.url',
      args: {},
    });
    expect(result).toBeNull();
    expect(error?.code).toBe('app.photos/not-found');
    expect(error?.message).toBe('missing');
  });
});

describe('createPluginRouter concurrency', () => {
  function gate() {
    let release: () => void = () => {};
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { open, release };
  }

  function invokeHeader(pluginId: string, event: string, requestId: string) {
    return { type: 'INVOKE_REQUEST', pluginId, event, requestId } as const;
  }

  function registryWith(
    invoke: (event: string) => Promise<[null, unknown]> | [null, unknown],
    pluginId = 'app.slow',
  ) {
    const registry = createPluginRegistry();
    registry.register({
      id: pluginId,
      events: ['slow', 'fast'],
      runtimes: { bare: { invoke: (event) => invoke(event) } },
    });
    return registry;
  }

  it('answers a fast call while a slow call on the same router is pending', async () => {
    const slow = gate();
    const router = createPluginRouter(
      registryWith(async (event) => {
        if (event === 'slow') await slow.open;
        return ok({ event });
      }),
      'bare',
    );

    const slowCall = router.route(
      invokeHeader('app.slow', 'slow', 's1'),
      new Uint8Array(),
    );
    const fast = await router.route(
      invokeHeader('app.slow', 'fast', 'f1'),
      new Uint8Array(),
    );
    expect(fast?.result).toEqual({ event: 'fast' });

    slow.release();
    expect((await slowCall)?.result).toEqual({ event: 'slow' });
  });

  it('rejects calls beyond maxInflight with a clear error and recovers after', async () => {
    const slow = gate();
    const router = createPluginRouter(
      registryWith(async (event) => {
        if (event === 'slow') await slow.open;
        return ok({ event });
      }),
      'bare',
      { maxInflight: 2, maxInflightPerPlugin: 2 },
    );

    const first = router.route(
      invokeHeader('app.slow', 'slow', 'a'),
      new Uint8Array(),
    );
    const second = router.route(
      invokeHeader('app.slow', 'slow', 'b'),
      new Uint8Array(),
    );
    const over = await router.route(
      invokeHeader('app.slow', 'fast', 'c'),
      new Uint8Array(),
    );
    expect(over?.requestId).toBe('c');
    expect(over?.error?.code).toBe(ErrorCode.TRANSPORT_ERROR);
    expect(over?.error?.message).toMatch(
      /too many calls in flight \(limit 2\)/,
    );

    slow.release();
    await Promise.all([first, second]);
    const after = await router.route(
      invokeHeader('app.slow', 'fast', 'd'),
      new Uint8Array(),
    );
    expect(after?.result).toEqual({ event: 'fast' });
  });

  it('runs calls to a serialPlugins plugin one at a time, in arrival order', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const router = createPluginRouter(
      registryWith(async (event) => {
        started.push(event);
        const g = gate();
        gates.set(event, g);
        await g.open;
        finished.push(event);
        return ok({ event });
      }, 'app.ordered'),
      'bare',
      { serialPlugins: ['app.ordered'] },
    );

    const a = router.route(
      invokeHeader('app.ordered', 'slow', 'a'),
      new Uint8Array(),
    );
    const b = router.route(
      invokeHeader('app.ordered', 'fast', 'b'),
      new Uint8Array(),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['slow']);

    gates.get('slow')!.release();
    await a;
    await vi.waitFor(() => expect(started).toEqual(['slow', 'fast']));
    gates.get('fast')!.release();
    await b;
    expect(finished).toEqual(['slow', 'fast']);
  });

  it('does not let a serial plugin block other plugins', async () => {
    const slow = gate();
    const registry = createPluginRegistry();
    registry.register({
      id: 'app.ordered',
      events: ['slow'],
      runtimes: {
        bare: {
          invoke: async () => {
            await slow.open;
            return ok({});
          },
        },
      },
    });
    registry.register({
      id: 'app.other',
      events: ['fast'],
      runtimes: { bare: { invoke: () => ok({ fast: true }) } },
    });
    const router = createPluginRouter(registry, 'bare', {
      serialPlugins: ['app.ordered'],
    });

    const pending = router.route(
      invokeHeader('app.ordered', 'slow', 'a'),
      new Uint8Array(),
    );
    const other = await router.route(
      invokeHeader('app.other', 'fast', 'b'),
      new Uint8Array(),
    );
    expect(other?.result).toEqual({ fast: true });
    slow.release();
    await pending;
  });
});

describe('security-review hardening', () => {
  const quiet = () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

  function slowRegistry(ids: string[], open: Promise<void>) {
    const registry = createPluginRegistry();
    for (const id of ids) {
      registry.register({
        id,
        events: ['slow'],
        runtimes: {
          bare: {
            invoke: async () => {
              await open;
              return ok({ id });
            },
          },
        },
      });
    }
    return registry;
  }

  function call(pluginId: string, requestId: string) {
    return {
      type: 'INVOKE_REQUEST',
      pluginId,
      event: 'slow',
      requestId,
    } as const;
  }

  it('rejects malformed ids and reserves core.* / vendor.* for framework plugins (D-10)', () => {
    const registry = createPluginRegistry();
    for (const id of ['a.', '.b', 'a b.c', 'a.b/c', `a.${'x'.repeat(300)}`]) {
      expect(() => registry.register({ id, runtimes: {} })).toThrow(
        /namespaced/,
      );
    }
    expect(() => registry.register({ id: 'core.evil', runtimes: {} })).toThrow(
      /reserved for framework plugins/,
    );
    expect(() =>
      registry.register({ id: 'vendor.plugin', runtimes: {} }),
    ).toThrow(/reserved for framework plugins/);
    for (const id of [
      'core.health',
      'core.discovery',
      'core.permissions',
      'core.logs',
      'vendor.media',
      'app.my-plugin_2',
    ]) {
      expect(() => registry.register({ id, runtimes: {} })).not.toThrow();
    }
  });

  it('passes the manifest host timeout of the event to delegateToHost (C-1)', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.permissions',
      events: ['permissions.request', 'permissions.status'],
      hostTimeoutsMs: { 'permissions.request': 300_000 },
      runtimes: {},
    });
    const delegateToHost = vi.fn(
      async (
        header: { requestId?: string },
        _payload: Uint8Array,
        _timeoutMs?: number,
      ) => ({
        type: 'INVOKE_RESPONSE' as const,
        pluginId: 'core.permissions',
        event: 'x',
        requestId: header.requestId,
        result: {},
      }),
    );
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost,
      getHostCapabilities: async () => [
        {
          pluginId: 'core.permissions',
          capabilities: [],
          events: ['permissions.request', 'permissions.status'],
          runtimes: ['android'],
        },
      ],
    });
    for (const event of ['permissions.request', 'permissions.status']) {
      await router.route(
        {
          type: 'INVOKE_REQUEST',
          pluginId: 'core.permissions',
          event,
          requestId: event,
        },
        new Uint8Array(0),
      );
    }
    expect(delegateToHost.mock.calls[0][2]).toBe(300_000);
    expect(delegateToHost.mock.calls[1][2]).toBeUndefined();
  });

  it('keeps a canonical CoreError code from a throw but never its message (C-9)', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.permissions',
      events: ['permissions.request'],
      runtimes: {},
    });
    const logger = quiet();
    const router = createPluginRouter(registry, 'bare', {
      logger,
      delegateToHost: async () => {
        throw new CoreError(
          ErrorCode.TIMEOUT,
          'Host IPC timeout waiting for HOST_INVOKE_RESPONSE (secret-id)',
        );
      },
      getHostCapabilities: async () => [
        {
          pluginId: 'core.permissions',
          capabilities: [],
          events: ['permissions.request'],
          runtimes: ['ios'],
        },
      ],
    });
    const response = await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.request',
        requestId: 'r',
      },
      new Uint8Array(0),
    );
    expect(response?.error).toEqual({
      code: 'TIMEOUT',
      message: 'core.permissions.permissions.request timed out',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('secret-id'),
    );
  });

  it('caps calls per channel so one peer cannot take every slot (C-11)', async () => {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const router = createPluginRouter(
      slowRegistry(['app.a', 'app.b'], open),
      'bare',
      {
        maxInflight: 4,
        maxInflightPerChannel: 2,
        maxInflightPerPlugin: 4,
        logger: quiet(),
      },
    );
    const held = [
      router.route(call('app.a', '1'), new Uint8Array(), { channel: '[ws]' }),
      router.route(call('app.b', '2'), new Uint8Array(), { channel: '[ws]' }),
    ];
    const over = await router.route(call('app.a', '3'), new Uint8Array(), {
      channel: '[ws]',
    });
    expect(over?.error?.code).toBe(ErrorCode.TRANSPORT_ERROR);
    expect(over?.error?.message).toMatch(/on this channel \(limit 2\)/);
    // The other channel still has room.
    const ipc = router.route(call('app.a', '4'), new Uint8Array(), {
      channel: '[ipc]',
    });
    release();
    expect((await ipc)?.result).toEqual({ id: 'app.a' });
    await Promise.all(held);
    const after = await router.route(call('app.a', '5'), new Uint8Array(), {
      channel: '[ws]',
    });
    expect(after?.error).toBeUndefined();
  });

  it('caps calls per plugin when maxInflightPerPlugin is set (D-9)', async () => {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const router = createPluginRouter(
      slowRegistry(['app.slow', 'app.ok'], open),
      'bare',
      {
        maxInflight: 8,
        maxInflightPerPlugin: 4,
        logger: quiet(),
      },
    );
    const held = [1, 2, 3, 4].map((n) =>
      router.route(call('app.slow', `s${n}`), new Uint8Array()),
    );
    const over = await router.route(call('app.slow', 's5'), new Uint8Array());
    expect(over?.error?.message).toMatch(/for this plugin \(limit 4\)/);
    const other = router.route(call('app.ok', 'o1'), new Uint8Array());
    release();
    expect((await other)?.result).toEqual({ id: 'app.ok' });
    await Promise.all(held);
  });

  it('lets one plugin use every slot by default, so bursty apps are not throttled (adv-B-2)', async () => {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const router = createPluginRouter(
      slowRegistry(['app.grid'], open),
      'bare',
      {
        maxInflight: 8,
        logger: quiet(),
      },
    );
    const held = Array.from({ length: 8 }, (_, n) =>
      router.route(call('app.grid', `g${n}`), new Uint8Array()),
    );
    const over = await router.route(call('app.grid', 'g8'), new Uint8Array());
    expect(over?.error?.message).toMatch(
      /too many calls in flight \(limit 8\)/,
    );
    release();
    for (const result of await Promise.all(held)) {
      expect(result?.error).toBeUndefined();
    }
  });

  it('caps a manifest host timeout at the setTimeout limit (adv-A-7)', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.permissions',
      events: ['permissions.request'],
      hostTimeoutsMs: { 'permissions.request': 1e12 },
      runtimes: {},
    });
    const delegateToHost = vi.fn(
      async (_h: unknown, _p: Uint8Array, _t?: number) => null,
    );
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost,
      logger: quiet(),
      getHostCapabilities: async () => [
        {
          pluginId: 'core.permissions',
          capabilities: [],
          events: ['permissions.request'],
          runtimes: ['ios'],
        },
      ],
    });
    await router.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.request',
        requestId: 'r',
      },
      new Uint8Array(0),
    );
    expect(delegateToHost.mock.calls[0][2]).toBe(2 ** 31 - 1);
  });
});
