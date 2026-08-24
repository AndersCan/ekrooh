import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createHostIpcBridge, type BareIpcLike } from './host-ipc';
import { createFrameDecoder } from './framing';
import { MessageProtocol } from './wire-codec';
import { MessageType } from './constants';
import type { MessageHeader, RuntimeTarget } from './types';

afterEach(() => {
  vi.useRealTimers();
});

class FakeIpc implements BareIpcLike {
  writes: Uint8Array[] = [];

  write(data: Uint8Array | Buffer | string): boolean {
    this.writes.push(
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data),
    );
    return true;
  }
}

const CAPABILITIES = [
  {
    pluginId: 'core.permissions',
    capabilities: [] as string[],
    events: ['permissions.requestStorage'],
    runtimes: ['android'] as RuntimeTarget[],
  },
];

describe('createHostIpcBridge', () => {
  it('queries host capabilities', async () => {
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol });

    const promise = bridge.queryCapabilities();
    expect(ipc.writes).toHaveLength(1);
    const sent = protocol.decode(ipc.writes[0]);
    expect(sent.header.type).toBe('HOST_CAPABILITIES_QUERY');

    const response = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_CAPABILITIES_RESPONSE',
        requestId: (sent.header as { requestId: string }).requestId,
        capabilities: CAPABILITIES,
      } satisfies MessageHeader,
      null,
    );
    bridge.tryConsumeDownstreamFromHost(response);

    const caps = await promise;
    expect(caps).toEqual(CAPABILITIES);
  });

  it('invokes an event on the host and maps the response back', async () => {
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol });

    const promise = bridge.invokeOnHost(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'host-invoke-1',
        args: {},
      },
      new Uint8Array([1, 2]),
    );

    const sent = protocol.decode(ipc.writes[0]);
    expect(sent.header.type).toBe('HOST_INVOKE_REQUEST');
    expect(sent.header.requestId).toBe('host-invoke-1');
    expect(Array.from(sent.payload)).toEqual([1, 2]);

    const response = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_INVOKE_RESPONSE',
        requestId: 'host-invoke-1',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        result: { granted: true },
      } satisfies MessageHeader,
      null,
    );
    bridge.tryConsumeDownstreamFromHost(response);

    const out = await promise;
    expect(out?.type).toBe('INVOKE_RESPONSE');
    expect(out?.result).toEqual({ granted: true });
  });

  it('returns null when invoked without a request id', async () => {
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol });
    const out = await bridge.invokeOnHost(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
      },
      new Uint8Array(0),
    );
    expect(out).toBeNull();
  });

  it('does not consume messages that are not host responses', () => {
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol });
    const frame = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'DISPATCH',
        pluginId: 'core.health',
        event: 'health.ping',
      },
      null,
    );
    expect(bridge.tryConsumeDownstreamFromHost(frame)).toBe(false);
  });

  it('times out a host invoke with the default 30s bound', async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol });
    const promise = bridge.invokeOnHost(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'host-timeout-1',
        args: {},
      },
      new Uint8Array(0),
    );
    const assertion = expect(promise).rejects.toThrow(/Host IPC timeout/);
    vi.advanceTimersByTime(30001);
    await assertion;
  });

  it('resolves a pending host call when its frame arrives split', async () => {
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol });
    const decoder = createFrameDecoder(protocol);

    const promise = bridge.queryCapabilities();
    const sent = protocol.decode(ipc.writes[0]);
    const frame = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_CAPABILITIES_RESPONSE',
        requestId: (sent.header as { requestId: string }).requestId,
        capabilities: CAPABILITIES,
      } satisfies MessageHeader,
      null,
    );

    // Host→worklet frames arrive over a Node-style Readable without message
    // boundaries; chunk this one arbitrarily through the real frame decoder.
    const pieces = [
      frame.subarray(0, 4),
      frame.subarray(4, 9),
      frame.subarray(9),
    ];
    for (const piece of pieces) {
      for (const parsed of decoder.push(piece)) {
        expect(bridge.tryConsumeDownstream(parsed)).toBe(true);
      }
    }
    expect(await promise).toEqual(CAPABILITIES);
  });

  it('resolves coalesced host frames delivered in one chunk', async () => {
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol });
    const decoder = createFrameDecoder(protocol);

    const p1 = bridge.invokeOnHost(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'coal-1',
        args: {},
      },
      new Uint8Array(0),
    );
    const p2 = bridge.invokeOnHost(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'coal-2',
        args: {},
      },
      new Uint8Array(0),
    );

    const r1 = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_INVOKE_RESPONSE',
        requestId: 'coal-1',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        result: { ok: 1 },
      } satisfies MessageHeader,
      null,
    );
    const r2 = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_INVOKE_RESPONSE',
        requestId: 'coal-2',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        result: { ok: 2 },
      } satisfies MessageHeader,
      null,
    );
    const coalesced = new Uint8Array(r1.byteLength + r2.byteLength);
    coalesced.set(r1, 0);
    coalesced.set(r2, r1.byteLength);

    let consumed = 0;
    for (const parsed of decoder.push(coalesced)) {
      if (bridge.tryConsumeDownstream(parsed)) consumed++;
    }
    expect(consumed).toBe(2);
    expect(await p1).toMatchObject({ type: 'INVOKE_RESPONSE' });
    expect(await p2).toMatchObject({ type: 'INVOKE_RESPONSE' });
  });

  it('rejects a superseded in-flight call instead of leaking its timer', async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol });

    const first = bridge.invokeOnHost(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'dup-1',
        args: {},
      },
      new Uint8Array(0),
    );
    const second = bridge.invokeOnHost(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'dup-1',
        args: {},
      },
      new Uint8Array(0),
    );

    // The second call supersedes the first: the first promise must reject
    // (its timer is cleared, so advancing time must not also time it out).
    await expect(first).rejects.toThrow(/superseded/);
    expect(second).toBeDefined();

    const response = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_INVOKE_RESPONSE',
        requestId: 'dup-1',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        result: { ok: true },
      } satisfies MessageHeader,
      null,
    );
    bridge.tryConsumeDownstreamFromHost(response);
    await expect(second).resolves.toMatchObject({ type: 'INVOKE_RESPONSE' });

    // The superseded call's timer must be gone: advancing past the default
    // timeout must not trigger a second rejection.
    vi.advanceTimersByTime(30001);
  });

  it('logs a debug trace when a host frame cannot be decoded', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const ipc = new FakeIpc();
      const protocol = new MessageProtocol();
      const bridge = createHostIpcBridge({ ipc, protocol });
      // Bad version byte — decode fails and the bridge swallows it.
      expect(
        bridge.tryConsumeDownstreamFromHost(
          new Uint8Array([0xff, 0x00, 0x00, 0x00]),
        ),
      ).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
