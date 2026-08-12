import { describe, expect, it, vi } from 'vite-plus/test';
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
    registry.register({ id: 'vendor.plugin', runtimes: {} });
    expect(() =>
      registry.register({ id: 'vendor.plugin', runtimes: {} }),
    ).toThrow(/already registered/);
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
      id: 'core.other',
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
    registry.register({ id: 'core.health', runtimes: {} });
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
    expect(response?.error?.message).toBe('adapter exploded');
  });

  it('wraps dispatch exceptions as PLUGIN_ERROR and logs them', async () => {
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
      runtimes: {
        bare: {
          dispatch: () => {
            throw new Error('dispatch exploded');
          },
        },
      },
    });
    const logger = { warn: vi.fn(), error: vi.fn() };
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

  it('delegates to the host when no adapter exists', async () => {
    const registry = createPluginRegistry();
    registry.register({ id: 'core.permissions', runtimes: {} });
    const delegated: PluginInvokeResponseHeader = {
      type: 'INVOKE_RESPONSE',
      pluginId: 'core.permissions',
      event: 'permissions.requestStorage',
      requestId: 'r3',
      result: { granted: true },
    };
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost: async () => delegated,
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

  it('returns UNSUPPORTED_CAPABILITY when neither adapter nor host handles it', async () => {
    const registry = createPluginRegistry();
    registry.register({ id: 'core.health', runtimes: {} });
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
    registry.register({ id: 'core.permissions', runtimes: {} });
    const router = createPluginRouter(registry, 'bare', {
      delegateToHost: async () => {
        throw new Error('host exploded');
      },
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
    expect(response?.error?.message).toBe('host exploded');
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
});

describe('integration: messenger + protocol + bus over an encoded channel', () => {
  it('performs an invoke round-trip through the wire codec', async () => {
    const protocol = new MessageProtocol();
    const registry = createPluginRegistry();
    registry.register({
      id: 'core.health',
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
