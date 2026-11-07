import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createHostIpcBridge, type BareIpcLike } from './host-ipc';
import { createFrameDecoder } from './framing';
import { MessageProtocol } from './wire-codec';
import { barePlatform as platform } from '../lib/bare-platform';
import { MessageType } from './constants';
import type {
  MessageHeader,
  PluginInvokeRequestHeader,
  RuntimeTarget,
} from './types';

afterEach(() => {
  vi.useRealTimers();
});

/** The request id the bridge put on the host channel in its `index`th write. */
function sentRequestId(
  protocol: MessageProtocol,
  ipc: FakeIpc,
  index: number,
): string {
  return (protocol.decode(ipc.writes[index]).header as { requestId: string })
    .requestId;
}

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
    const bridge = createHostIpcBridge({ ipc, protocol, platform });

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
    const bridge = createHostIpcBridge({ ipc, protocol, platform });

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
    // The page's id never reaches the host channel.
    expect(sent.header.requestId).not.toBe('host-invoke-1');
    expect(Array.from(sent.payload)).toEqual([1, 2]);

    const response = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_INVOKE_RESPONSE',
        requestId: sentRequestId(protocol, ipc, 0),
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        result: { granted: true },
      } satisfies MessageHeader,
      null,
    );
    bridge.tryConsumeDownstreamFromHost(response);

    const out = await promise;
    expect(out?.type).toBe('INVOKE_RESPONSE');
    expect(out?.requestId).toBe('host-invoke-1');
    expect(out?.result).toEqual({ granted: true });
  });

  it('does not answer a host call with a response addressed by the page id', async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol, platform });

    const promise = bridge.invokeOnHost(
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        requestId: 'page-chosen',
        args: {},
      },
      new Uint8Array(0),
    );
    const settled = expect(promise).rejects.toThrow(/Host IPC timeout/);
    const forged = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_INVOKE_RESPONSE',
        requestId: 'page-chosen',
        pluginId: 'core.permissions',
        event: 'permissions.requestStorage',
        result: { granted: true },
      } satisfies MessageHeader,
      null,
    );
    expect(bridge.tryConsumeDownstreamFromHost(forged)).toBe(false);
    vi.advanceTimersByTime(30001);
    await settled;
  });

  it('writes an already-encoded Buffer to the IPC without copying it again', async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const bridge = createHostIpcBridge({
      ipc,
      protocol: new MessageProtocol(),
      platform,
    });
    const fromSpy = vi.spyOn(Buffer, 'from');
    try {
      const pending = bridge.queryCapabilities(10);
      const settled = expect(pending).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(11);
      await settled;
      expect(ipc.writes).toHaveLength(1);
      expect(fromSpy).not.toHaveBeenCalled();
    } finally {
      fromSpy.mockRestore();
    }
  });

  it('returns null when invoked without a request id', async () => {
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol, platform });
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
    const bridge = createHostIpcBridge({ ipc, protocol, platform });
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
    const bridge = createHostIpcBridge({ ipc, protocol, platform });
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
    const bridge = createHostIpcBridge({ ipc, protocol, platform });
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
    const bridge = createHostIpcBridge({ ipc, protocol, platform });
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
        requestId: sentRequestId(protocol, ipc, 0),
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
        requestId: sentRequestId(protocol, ipc, 1),
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

  it('keeps two calls with the same page id apart', async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol, platform });

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

    // A repeated page id must not supersede the first call: each gets its own
    // host-channel id and its own answer.
    const ids = [0, 1].map((i) => sentRequestId(protocol, ipc, i));
    expect(ids[0]).not.toBe(ids[1]);
    ids.forEach((requestId, i) => {
      bridge.tryConsumeDownstreamFromHost(
        protocol.encode(
          MessageType.ENVELOPE,
          {
            type: 'HOST_INVOKE_RESPONSE',
            requestId,
            pluginId: 'core.permissions',
            event: 'permissions.requestStorage',
            result: { call: i },
          } satisfies MessageHeader,
          null,
        ),
      );
    });
    await expect(first).resolves.toMatchObject({ result: { call: 0 } });
    await expect(second).resolves.toMatchObject({ result: { call: 1 } });
  });

  it('logs a debug trace when a host frame cannot be decoded', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const ipc = new FakeIpc();
      const protocol = new MessageProtocol();
      const bridge = createHostIpcBridge({ ipc, protocol, platform });
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

  function permissionsCall(requestId: string): PluginInvokeRequestHeader {
    return {
      type: 'INVOKE_REQUEST',
      pluginId: 'core.permissions',
      event: 'permissions.request',
      requestId,
      args: {},
    };
  }

  function hostAnswer(
    protocol: MessageProtocol,
    requestId: string,
    extra: Partial<MessageHeader> = {},
  ) {
    return protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_INVOKE_RESPONSE',
        requestId,
        pluginId: 'core.permissions',
        event: 'permissions.request',
        ...extra,
      } as MessageHeader,
      null,
    );
  }

  it('honours a per-call timeout so a user-mediated host call can outlive 30 s (C-1)', async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol, platform });
    const promise = bridge.invokeOnHost(
      permissionsCall('slow-user'),
      new Uint8Array(0),
      300_000,
    );
    vi.advanceTimersByTime(60_000);
    bridge.tryConsumeDownstreamFromHost(
      hostAnswer(protocol, sentRequestId(protocol, ipc, 0), {
        result: { status: 'granted' },
      } as Partial<MessageHeader>),
    );
    await expect(promise).resolves.toMatchObject({
      requestId: 'slow-user',
      result: { status: 'granted' },
    });
  });

  it('rejects a host timeout with a TIMEOUT CoreError', async () => {
    vi.useFakeTimers();
    const bridge = createHostIpcBridge({
      ipc: new FakeIpc(),
      protocol: new MessageProtocol(),
      platform,
    });
    const promise = bridge.invokeOnHost(
      permissionsCall('t'),
      new Uint8Array(0),
    );
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    vi.advanceTimersByTime(30_001);
    await assertion;
  });

  it('evicts the oldest pending host call past the 1024 cap (C-6)', async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol, platform });
    const calls = Array.from({ length: 1025 }, (_, i) =>
      bridge.invokeOnHost(permissionsCall(`c${i}`), new Uint8Array(0)),
    );
    const oldestId = sentRequestId(protocol, ipc, 0);
    await expect(calls[0]).rejects.toThrow(
      new RegExp(`too many concurrent host calls \\(${oldestId}\\)`),
    );
    // The evicted id no longer resolves anything; the newest still does.
    expect(
      bridge.tryConsumeDownstreamFromHost(hostAnswer(protocol, oldestId)),
    ).toBe(false);
    expect(
      bridge.tryConsumeDownstreamFromHost(
        hostAnswer(protocol, sentRequestId(protocol, ipc, 1024)),
      ),
    ).toBe(true);
    await expect(calls[1024]).resolves.toMatchObject({ requestId: 'c1024' });
    vi.advanceTimersByTime(30_001);
    await Promise.allSettled(calls);
  });

  it('passes canonical and app-scoped host error codes only, and keeps the request routing (D-6)', async () => {
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol, platform });
    const cases: Array<[string, string]> = [
      ['TIMEOUT', 'TIMEOUT'],
      ['app.photos/not-found', 'app.photos/not-found'],
      ['toString', 'HOST_ERROR'],
      ['<script>', 'HOST_ERROR'],
    ];
    for (const [i, [code, expected]] of cases.entries()) {
      const promise = bridge.invokeOnHost(
        permissionsCall(`e${i}`),
        new Uint8Array(0),
      );
      bridge.tryConsumeDownstreamFromHost(
        hostAnswer(protocol, sentRequestId(protocol, ipc, i), {
          pluginId: 'spoofed.plugin',
          event: 'spoofed',
          error: { code, message: 'm'.repeat(2000) },
        } as Partial<MessageHeader>),
      );
      const out = await promise;
      expect(out?.error?.code).toBe(expected);
      expect(out?.error?.message.length).toBe(512);
      expect(out?.pluginId).toBe('core.permissions');
      expect(out?.event).toBe('permissions.request');
    }
  });

  it('close() rejects every pending call, clears its timer, and refuses later calls', async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const protocol = new MessageProtocol();
    const bridge = createHostIpcBridge({ ipc, protocol, platform });
    const a = bridge.invokeOnHost(permissionsCall('a'), new Uint8Array(0));
    const caps = bridge.queryCapabilities();
    const settledA = expect(a).rejects.toThrow('runtime closing');
    const settledCaps = expect(caps).rejects.toThrow('runtime closing');
    bridge.close('runtime closing');
    await settledA;
    await settledCaps;
    expect(vi.getTimerCount()).toBe(0);
    // A late answer for a closed call is not consumed.
    expect(
      bridge.tryConsumeDownstreamFromHost(
        hostAnswer(protocol, sentRequestId(protocol, ipc, 0)),
      ),
    ).toBe(false);
    const writes = ipc.writes.length;
    await expect(
      bridge.invokeOnHost(permissionsCall('late'), new Uint8Array(0)),
    ).rejects.toThrow('runtime closing');
    await expect(bridge.queryCapabilities()).rejects.toThrow('runtime closing');
    expect(ipc.writes.length).toBe(writes);
    bridge.close();
  });
});
