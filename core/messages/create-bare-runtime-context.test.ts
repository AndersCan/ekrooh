import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('bare-encoding', async () => ({
  TextEncoder: (await import('node:util')).TextEncoder,
  TextDecoder: (await import('node:util')).TextDecoder,
}));

import { createBareRuntimeContext } from './create-bare-runtime-context';
import { MessageType } from './constants';
import { createHealthPlugin } from '../../plugins/health/plugin';

describe('createBareRuntimeContext', () => {
  it('builds a protocol, registry and router wired together', async () => {
    const ctx = createBareRuntimeContext([createHealthPlugin()]);
    expect(ctx.protocol).toBeDefined();
    expect(ctx.pluginRegistry).toBeDefined();

    const response = await ctx.pluginRouter.route(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'r1',
        args: { message: 'hi' },
      },
      new Uint8Array(0),
    );
    expect(response?.result).toEqual({ message: 'hi', ts: expect.any(Number) });
  });

  it('round-trips an envelope through the runtime codec', () => {
    const ctx = createBareRuntimeContext();
    const header = {
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'rt',
      args: { message: 'x' },
    } as const;
    const encoded = ctx.protocol.encode(
      MessageType.ENVELOPE,
      header,
      new Uint8Array(0),
    );
    const decoded = ctx.protocol.decode(encoded);
    expect(decoded.header).toMatchObject({
      type: 'INVOKE_REQUEST',
      event: 'health.ping',
      requestId: 'rt',
    });
  });

  it('accepts the default plugin list', () => {
    const ctx = createBareRuntimeContext();
    expect(ctx.pluginRegistry).toBeDefined();
  });
});
