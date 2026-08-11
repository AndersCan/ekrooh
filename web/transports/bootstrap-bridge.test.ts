import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { MessageProtocol, MessageType, WireMessage } from '../../core/messages';
import { createBootstrapBridgeTransport } from './bootstrap-bridge';

const SENTINEL_BINARY = '__less_bare_port__:binary';

type WindowLike = {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
};

function installWindow(): {
  dispatchMessage: (event: unknown) => void;
} {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
  } satisfies WindowLike;
  return {
    dispatchMessage: (event) => {
      for (const listener of listeners.get('message') ?? []) listener(event);
    },
  };
}

function encode(header: object, payload?: Uint8Array | null): ArrayBuffer {
  const bytes = new MessageProtocol().encode(
    MessageType.ENVELOPE,
    header as never,
    payload ?? null,
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Hand the port to the transport and capture everything it sends on it. */
function handed(
  channel: MessageChannel,
  win: { dispatchMessage: (e: unknown) => void },
) {
  const frames: ArrayBuffer[] = [];
  const received = new Promise<ArrayBuffer>((resolve) => {
    channel.port2.onmessage = (event) => {
      const frame = event.data as ArrayBuffer;
      frames.push(frame);
      resolve(frame);
    };
  });
  win.dispatchMessage({ data: SENTINEL_BINARY, ports: [channel.port1] });
  return { frames, received };
}

beforeEach(() => {
  installWindow();
});

describe('createBootstrapBridgeTransport', () => {
  it('queues frames until the port is handed over', async () => {
    const channel = new MessageChannel();
    const win = installWindow();
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

    const { received } = handed(channel, win);
    const frame = await received;
    const decoded = new MessageProtocol().decode(frame);
    expect(decoded.header).toMatchObject({
      type: 'INVOKE_REQUEST',
      requestId: 'b1',
    });
  });

  it('sends payloads as raw frame bytes over the port', async () => {
    const channel = new MessageChannel();
    const win = installWindow();
    const transport = createBootstrapBridgeTransport();

    const { received } = handed(channel, win);
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

    const frame = await received;
    const decoded = new MessageProtocol().decode(frame);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3]);
  });

  it('delivers backend frames decoded to subscribers', async () => {
    const channel = new MessageChannel();
    const win = installWindow();
    const transport = createBootstrapBridgeTransport();
    const received = new Promise<WireMessage>((resolve) => {
      transport.subscribe(resolve);
    });

    win.dispatchMessage({ data: SENTINEL_BINARY, ports: [channel.port1] });
    channel.port2.postMessage(
      encode(
        {
          type: 'INVOKE_RESPONSE',
          pluginId: 'core.health',
          event: 'health.ping',
          requestId: 'b3',
        },
        new Uint8Array([9, 8, 7]),
      ),
    );

    const message = await received;
    expect(message.header).toMatchObject({
      type: 'INVOKE_RESPONSE',
      requestId: 'b3',
    });
    expect(Array.from(message.payload)).toEqual([9, 8, 7]);
  });

  it('delivers messages without a payload as an empty buffer', async () => {
    const channel = new MessageChannel();
    const win = installWindow();
    const transport = createBootstrapBridgeTransport();
    const received = new Promise<WireMessage>((resolve) => {
      transport.subscribe(resolve);
    });

    win.dispatchMessage({ data: SENTINEL_BINARY, ports: [channel.port1] });
    channel.port2.postMessage(
      encode({
        type: 'DISPATCH',
        pluginId: 'core.health',
        event: 'health.ping',
      }),
    );

    const message = await received;
    expect(message.payload.byteLength).toBe(0);
  });

  it('ignores window messages that are not the port handoff', async () => {
    const channel = new MessageChannel();
    const win = installWindow();
    const transport = createBootstrapBridgeTransport();

    const frames: ArrayBuffer[] = [];
    channel.port2.onmessage = (event) => frames.push(event.data as ArrayBuffer);
    win.dispatchMessage({ data: 'unrelated', ports: [channel.port1] });

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'b5',
      },
      null,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toHaveLength(0);
  });
});
