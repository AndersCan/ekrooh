import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { TextDecoder, TextEncoder } from 'node:util';
import { MessageType } from './constants';
import { createFrameChannel } from './frame-channel';
import type { MessageHeader, PluginInvokeResponseHeader } from './types';
import { MessageProtocol } from './wire-codec';

const protocol = new MessageProtocol({
  encode: (str) => new TextEncoder().encode(str),
  decode: (bytes) => new TextDecoder().decode(bytes),
});

function invoke(requestId: string): Uint8Array {
  return protocol.encode(
    MessageType.ENVELOPE,
    {
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'ping',
      requestId,
    } as MessageHeader,
    null,
  );
}

function echoRouter() {
  return {
    route: vi.fn(
      async (header: MessageHeader): Promise<PluginInvokeResponseHeader> => ({
        type: 'INVOKE_RESPONSE',
        pluginId: 'core.health',
        event: 'ping',
        requestId: (header as { requestId: string }).requestId,
        result: { ok: true },
      }),
    ),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function responseIds(write: ReturnType<typeof vi.fn>): string[] {
  return write.mock.calls.map(
    ([frame]) =>
      (protocol.decode(frame as Uint8Array).header as { requestId: string })
        .requestId,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFrameChannel', () => {
  it('reassembles split and coalesced frames and answers each request', async () => {
    const write = vi.fn();
    const router = echoRouter();
    const channel = createFrameChannel({
      name: '[test]',
      protocol,
      router,
      write,
      onMalformed: { kind: 'tolerate' },
    });
    const a = invoke('a');
    const both = new Uint8Array([...invoke('b'), ...invoke('c')]);
    channel.push(a.subarray(0, 3));
    channel.push(a.subarray(3));
    channel.push(both);
    await flush();
    expect(responseIds(write)).toEqual(['a', 'b', 'c']);
  });

  it('ignores an empty chunk', async () => {
    const router = echoRouter();
    const channel = createFrameChannel({
      name: '[test]',
      protocol,
      router,
      write: vi.fn(),
      onMalformed: { kind: 'tolerate' },
    });
    channel.push(new Uint8Array(0));
    await flush();
    expect(router.route).not.toHaveBeenCalled();
  });

  it('lets an intercepted message skip routing', async () => {
    const router = echoRouter();
    const channel = createFrameChannel({
      name: '[test]',
      protocol,
      router,
      write: vi.fn(),
      onMalformed: { kind: 'tolerate' },
      intercept: (message) =>
        (message.header as { requestId: string }).requestId === 'host',
    });
    channel.push(invoke('host'));
    channel.push(invoke('plugin'));
    await flush();
    expect(router.route).toHaveBeenCalledTimes(1);
  });

  it('closes the peer on a malformed frame under the close policy', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const close = vi.fn();
    const router = echoRouter();
    const channel = createFrameChannel({
      name: '[ws]',
      protocol,
      router,
      write: vi.fn(),
      onMalformed: { kind: 'close', close },
    });
    channel.push(new Uint8Array([9, 9, 0, 0, 0, 0, 0]));
    expect(close).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[ws] malformed frame dropped'),
    );
    channel.push(invoke('after'));
    await flush();
    expect(router.route).not.toHaveBeenCalled();
  });

  it('treats a non-binary chunk as malformed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const close = vi.fn();
    const channel = createFrameChannel({
      name: '[ws]',
      protocol,
      router: echoRouter(),
      write: vi.fn(),
      onMalformed: { kind: 'close', close },
    });
    channel.push('text message');
    expect(close).toHaveBeenCalled();
  });

  it('tolerates a burst of malformed frames, then stops parsing for good', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = echoRouter();
    const channel = createFrameChannel({
      name: '[ipc]',
      protocol,
      router,
      write: vi.fn(),
      onMalformed: { kind: 'tolerate', maxConsecutiveFailures: 3 },
    });
    const garbage = new Uint8Array([9, 9, 0, 0, 0, 0, 0]);
    channel.push(garbage);
    channel.push(invoke('recovered'));
    await flush();
    expect(router.route).toHaveBeenCalledTimes(1);

    channel.push(garbage);
    channel.push(garbage);
    channel.push(garbage);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[ipc] channel permanently desynced'),
    );
    channel.push(invoke('ignored'));
    await flush();
    expect(router.route).toHaveBeenCalledTimes(1);
  });

  it('pauses the inbound stream while too much work is pending', async () => {
    const pause = vi.fn();
    const resume = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const router = {
      route: vi.fn(async () => {
        await gate;
        return null;
      }),
    };
    const channel = createFrameChannel({
      name: '[ws]',
      protocol,
      router,
      write: vi.fn(),
      onMalformed: { kind: 'close', close: vi.fn() },
      inbound: { maxPending: 2, pause, resume },
    });
    channel.push(invoke('1'));
    expect(pause).not.toHaveBeenCalled();
    channel.push(invoke('2'));
    expect(pause).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('logs a routing failure without affecting later calls', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.fn();
    const router = echoRouter();
    router.route.mockRejectedValueOnce(new Error('boom'));
    const channel = createFrameChannel({
      name: '[ipc]',
      protocol,
      router,
      write,
      onMalformed: { kind: 'tolerate' },
    });
    channel.push(invoke('fails'));
    channel.push(invoke('works'));
    await flush();
    expect(error).toHaveBeenCalledWith('[ipc] routing failed: boom');
    expect(responseIds(write)).toEqual(['works']);
  });

  it('stops after close', async () => {
    const router = echoRouter();
    const channel = createFrameChannel({
      name: '[ws]',
      protocol,
      router,
      write: vi.fn(),
      onMalformed: { kind: 'tolerate' },
    });
    channel.close();
    channel.push(invoke('late'));
    await flush();
    expect(router.route).not.toHaveBeenCalled();
  });
});
