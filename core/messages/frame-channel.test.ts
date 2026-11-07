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

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
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

  it('keeps a buffered partial frame when a non-binary chunk arrives (tolerate)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.fn();
    const channel = createFrameChannel({
      name: '[ipc]',
      protocol,
      router: echoRouter(),
      write,
      onMalformed: { kind: 'tolerate' },
    });
    const frame = invoke('kept');
    channel.push(frame.subarray(0, 4));
    channel.push('stray');
    channel.push(frame.subarray(4));
    await flush();
    expect(responseIds(write)).toEqual(['kept']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[ipc] non-binary chunk dropped'),
    );
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

  it('logs a routing failure and answers it without affecting later calls', async () => {
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
    // The failed invoke is answered with an error, never left to time out.
    expect(responseIds(write).sort()).toEqual(['fails', 'works']);
    const failed = write.mock.calls
      .map(([frame]) => protocol.decode(frame as Uint8Array).header)
      .find(
        (h) => (h as { requestId: string }).requestId === 'fails',
      ) as PluginInvokeResponseHeader;
    expect(failed.error).toEqual({
      code: 'PLUGIN_ERROR',
      message: 'core.health.ping failed',
    });
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

  it('answers a request whose content is invalid with FRAME_INVALID and keeps the stream (C-4)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const close = vi.fn();
    const write = vi.fn();
    const router = echoRouter();
    const channel = createFrameChannel({
      name: '[ws]',
      protocol,
      router,
      write,
      onMalformed: { kind: 'close', close },
    });
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { d: deep };
    const bad = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'ping',
        requestId: 'bad',
        args: { deep },
      } as MessageHeader,
      null,
    );
    channel.push(concat(invoke('before'), bad, invoke('after')));
    await flush();
    expect(close).not.toHaveBeenCalled();
    expect(router.route).toHaveBeenCalledTimes(2);
    const headers = write.mock.calls.map(
      ([frame]) =>
        protocol.decode(frame as Uint8Array)
          .header as PluginInvokeResponseHeader,
    );
    expect(headers.find((h) => h.requestId === 'bad')?.error).toEqual({
      code: 'FRAME_INVALID',
      message: 'Frame could not be decoded',
    });
    expect(responseIds(write).sort()).toEqual(['after', 'bad', 'before']);
  });

  it('still routes frames decoded before a framing violation in the same chunk (C-4)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const close = vi.fn();
    const router = echoRouter();
    const channel = createFrameChannel({
      name: '[ws]',
      protocol,
      router,
      write: vi.fn(),
      onMalformed: { kind: 'close', close },
    });
    channel.push(concat(invoke('good'), new Uint8Array([9, 9, 0, 0, 0, 0, 0])));
    await flush();
    expect(router.route).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails the host call waiting on an undecodable host response instead of dropping the frames behind it (C-4)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const intercepted: MessageHeader[] = [];
    const channel = createFrameChannel({
      name: '[ipc]',
      protocol,
      router: echoRouter(),
      write: vi.fn(),
      onMalformed: { kind: 'tolerate' },
      intercept: (message) => {
        intercepted.push(message.header);
        return true;
      },
    });
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { d: deep };
    const response = (requestId: string, result: unknown) =>
      protocol.encode(
        MessageType.ENVELOPE,
        {
          type: 'HOST_INVOKE_RESPONSE',
          requestId,
          pluginId: 'p.x',
          event: 'e',
          result,
        } as MessageHeader,
        null,
      );
    channel.push(concat(response('h1', deep), response('h2', { ok: true })));
    const byId = new Map(
      intercepted.map((h) => [(h as { requestId: string }).requestId, h]),
    );
    expect(byId.get('h2')).toMatchObject({ result: { ok: true } });
    expect(byId.get('h1')).toMatchObject({
      type: 'HOST_INVOKE_RESPONSE',
      error: { code: 'FRAME_INVALID' },
    });
  });

  it('never leaves an unhandled rejection when even the error answer cannot be written (C-3)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const router = {
        route: vi.fn(async () => Promise.reject(new Error('x'))),
      };
      const channel = createFrameChannel({
        name: '[ipc]',
        protocol,
        router,
        write: () => {
          throw new Error('pipe closed');
        },
        onMalformed: { kind: 'tolerate' },
      });
      channel.push(invoke('r1'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('tags routed calls with the channel name (C-11)', async () => {
    const router = echoRouter();
    const channel = createFrameChannel({
      name: '[ipc]',
      protocol,
      router,
      write: vi.fn(),
      onMalformed: { kind: 'tolerate' },
    });
    channel.push(invoke('tagged'));
    await flush();
    expect(router.route).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { channel: '[ipc]' },
    );
  });

  it('answers an undecodable capabilities response as a capabilities response (adv-A-5)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const intercepted: MessageHeader[] = [];
    const channel = createFrameChannel({
      name: '[ipc]',
      protocol,
      router: echoRouter(),
      write: vi.fn(),
      onMalformed: { kind: 'tolerate' },
      intercept: (message) => {
        intercepted.push(message.header);
        return true;
      },
    });
    channel.push(
      protocol.encode(
        MessageType.ENVELOPE,
        {
          type: 'HOST_CAPABILITIES_RESPONSE',
          requestId: 'caps-1',
          capabilities: [],
          // An over-long id is a content error on any header type.
          pluginId: 'p'.repeat(300),
        } as unknown as MessageHeader,
        null,
      ),
    );
    expect(intercepted).toEqual([
      {
        type: 'HOST_CAPABILITIES_RESPONSE',
        requestId: 'caps-1',
        capabilities: [],
        error: { code: 'FRAME_INVALID', message: 'Frame could not be decoded' },
      },
    ]);
  });
});
