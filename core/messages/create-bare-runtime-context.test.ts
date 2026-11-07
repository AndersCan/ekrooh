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

  it('refuses a header that only decodes by U+FFFD substitution (C-2)', () => {
    // bare-encoding (mocked by the lenient node:util decoder here) has no
    // fatal mode; the context must still reject invalid UTF-8.
    const { protocol } = createBareRuntimeContext();
    const frame = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'a.b', event: 'XX' },
      null,
    );
    const text = new TextDecoder().decode(frame);
    const at = text.indexOf('XX');
    const bad = new Uint8Array(frame);
    bad[at] = 0xff;
    bad[at + 1] = 0xfe;
    expect(() => protocol.decode(bad)).toThrow(/FRAME_INVALID/);
    // A real U+FFFD in the header still decodes.
    const real = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'a.b', event: '\uFFFD' },
      null,
    );
    expect((protocol.decode(real).header as { event: string }).event).toBe(
      '\uFFFD',
    );
  });
});
