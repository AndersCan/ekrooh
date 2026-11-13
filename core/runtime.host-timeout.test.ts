import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageProtocol, MessageType } from './messages';
import { createWorkletRuntime } from './runtime';

// A host call that waits on the person (Face ID, passcode, picker) carries the
// page's invoke timeout (justus lock.setEnabled: 300 s). The worklet's leg to
// the host must not give up at its own 30 s default before the page does.
describe('host-delegated invoke timeout', () => {
  const protocol = new MessageProtocol({
    encode: (str) => new TextEncoder().encode(str),
    decode: (bytes) => new TextDecoder().decode(bytes),
  });
  const frame = (header: Record<string, unknown>) =>
    protocol.encode(
      MessageType.ENVELOPE,
      header as Parameters<typeof protocol.encode>[1],
      null,
    );

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers a host invoke that the host completes after 31 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ipc = Object.assign(new EventEmitter(), {
      write: vi.fn((_data: unknown) => true),
      resume() {},
    });
    vi.stubGlobal('BareKit', { IPC: ipc });
    const runtime = createWorkletRuntime({
      port: 0,
      plugins: [
        {
          id: 'app.hosted',
          events: ['hosted.prompt'],
          runtimes: { ios: { invoke: () => [null, {}] } },
        },
      ],
    });
    const sent = () =>
      ipc.write.mock.calls.map(
        (c) => protocol.decode(new Uint8Array(c[0] as Buffer)).header,
      );
    const nextSent = async (type: string) => {
      await vi.waitFor(
        () => expect(sent().map((h) => h.type)).toContain(type),
        { timeout: 1000 },
      );
      return sent().find((h) => h.type === type) as Record<string, any>;
    };
    const send = (header: Record<string, unknown>) =>
      ipc.emit('data', Buffer.from(frame(header)));

    send({
      type: 'INVOKE_REQUEST',
      pluginId: 'app.hosted',
      event: 'hosted.prompt',
      requestId: 'r1',
      timeoutMs: 300_000,
    });
    const query = await nextSent('HOST_CAPABILITIES_QUERY');
    send({
      type: 'HOST_CAPABILITIES_RESPONSE',
      requestId: query.requestId,
      capabilities: [
        {
          pluginId: 'app.hosted',
          capabilities: [],
          events: ['hosted.prompt'],
          runtimes: ['ios'],
        },
      ],
    });
    const hostInvoke = await nextSent('HOST_INVOKE_REQUEST');

    // The person looks at the Face ID prompt for 31 s, then confirms.
    await vi.advanceTimersByTimeAsync(31_000);
    send({
      type: 'HOST_INVOKE_RESPONSE',
      requestId: hostInvoke.requestId,
      pluginId: 'app.hosted',
      event: 'hosted.prompt',
      result: { enabled: true },
    });

    const response = await nextSent('INVOKE_RESPONSE');
    expect(response.requestId).toBe('r1');
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ enabled: true });
    runtime.close();
  });
});
