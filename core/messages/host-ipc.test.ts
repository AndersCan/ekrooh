import { describe, expect, it } from 'vite-plus/test';
import { createHostIpcBridge, type BareIpcLike } from './host-ipc';
import { MessageProtocol } from './wire-codec';
import { MessageType } from './constants';
import type { MessageHeader, RuntimeTarget } from './types';

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
});
