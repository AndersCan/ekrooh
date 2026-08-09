import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { MessageType } from '../../core/messages';
import { createBootstrapBridgeTransport } from './bootstrap-bridge';

type BridgeWindow = {
  NativeBridge?: { send: (message: string) => void };
  onBackendMessage?: (msg: unknown) => void;
};

function fakeWindow(): BridgeWindow & Record<string, unknown> {
  return { NativeBridge: { send: () => {} } };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).window = fakeWindow();
});

describe('createBootstrapBridgeTransport', () => {
  it('sends framed envelopes through the injected bridge', () => {
    const sent: string[] = [];
    const win = window as BridgeWindow & {
      NativeBridge: { send: (m: string) => void };
    };
    win.NativeBridge = { send: (m) => sent.push(m) };

    const transport = createBootstrapBridgeTransport();
    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'b1',
      },
      null,
    );

    expect(sent).toHaveLength(1);
    const envelope = JSON.parse(sent[0]) as {
      type: number;
      header: Record<string, unknown>;
      payloadBase64: string | null;
    };
    expect(envelope.type).toBe(MessageType.ENVELOPE);
    expect(envelope.header).toMatchObject({ requestId: 'b1' });
    expect(envelope.payloadBase64).toBeNull();
  });

  it('encodes payloads as base64 in outbound envelopes', () => {
    const sent: string[] = [];
    const win = window as BridgeWindow & {
      NativeBridge: { send: (m: string) => void };
    };
    win.NativeBridge = { send: (m) => sent.push(m) };

    const transport = createBootstrapBridgeTransport();
    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.payloadEcho',
        requestId: 'b2',
      },
      new Uint8Array([1, 2, 3]),
    );

    const envelope = JSON.parse(sent[0]) as { payloadBase64: string };
    expect(Buffer.from(envelope.payloadBase64, 'base64')).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it('delivers backend messages with base64 payloads decoded', () => {
    const transport = createBootstrapBridgeTransport();
    const payloads: Uint8Array[] = [];
    transport.subscribe((message) => payloads.push(message.payload));

    const callback = (window as BridgeWindow).onBackendMessage;
    expect(typeof callback).toBe('function');
    callback?.({
      type: MessageType.ENVELOPE,
      header: {
        type: 'INVOKE_RESPONSE',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'b3',
      },
      payload: Buffer.from([9, 8, 7]).toString('base64'),
    });

    expect(payloads).toHaveLength(1);
    expect(Array.from(payloads[0])).toEqual([9, 8, 7]);
  });

  it('delivers messages without a payload as an empty buffer', () => {
    const transport = createBootstrapBridgeTransport();
    const payloads: Uint8Array[] = [];
    transport.subscribe((message) => payloads.push(message.payload));

    const callback = (window as BridgeWindow).onBackendMessage;
    callback?.({
      type: MessageType.ENVELOPE,
      header: {
        type: 'DISPATCH',
        pluginId: 'core.health',
        event: 'health.ping',
      },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0].byteLength).toBe(0);
  });
});
