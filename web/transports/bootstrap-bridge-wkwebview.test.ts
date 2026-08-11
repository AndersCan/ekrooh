import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { MessageProtocol, MessageType, WireMessage } from '../../core/messages';
import { createWkWebViewBridgeTransport } from './bootstrap-bridge-wkwebview';

type WindowLike = {
  webkit: {
    messageHandlers: {
      bareHost: { postMessage: (message: string) => void };
    };
  };
  onBareMessage?: (frame: string) => void;
  __lessBarePending: Array<Uint8Array>;
};

function installWindow(): {
  posted: string[];
  incoming: (base64: string) => void;
  pending: Array<Uint8Array>;
} {
  const posted: string[] = [];
  const pending: Array<Uint8Array> = [];
  const win: WindowLike = {
    webkit: {
      messageHandlers: {
        bareHost: {
          postMessage: (message) => {
            posted.push(message);
          },
        },
      },
    },
    __lessBarePending: pending,
  };
  (globalThis as Record<string, unknown>).window = win;
  return {
    posted,
    pending,
    incoming: (base64) => {
      win.onBareMessage?.(base64);
    },
  };
}

function encode(header: object, payload?: Uint8Array | null): string {
  const bytes = new MessageProtocol().encode(
    MessageType.ENVELOPE,
    header as never,
    payload ?? null,
  );
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(
    atob(data)
      .split('')
      .map((c) => c.charCodeAt(0)),
  );
}

beforeEach(() => {
  installWindow();
});

describe('createWkWebViewBridgeTransport', () => {
  it('posts outbound frames as base64 over the bareHost handler', () => {
    const { posted } = installWindow();
    const transport = createWkWebViewBridgeTransport();

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'w1',
      },
      null,
    );

    expect(posted).toHaveLength(1);
    const decoded = new MessageProtocol().decode(decodeBase64(posted[0]));
    expect(decoded.header).toMatchObject({
      type: 'INVOKE_REQUEST',
      requestId: 'w1',
    });
  });

  it('encodes payloads into the base64 frame bytes', () => {
    const { posted } = installWindow();
    const transport = createWkWebViewBridgeTransport();

    transport.send(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'core.health',
        event: 'health.payloadEcho',
        requestId: 'w2',
      },
      new Uint8Array([1, 2, 3]),
    );

    const bytes = decodeBase64(posted[0]);
    expect(Array.from(new MessageProtocol().decode(bytes).payload)).toEqual([
      1, 2, 3,
    ]);
  });

  it('delivers inbound frames decoded to subscribers', async () => {
    const win = installWindow();
    const transport = createWkWebViewBridgeTransport();
    const received = new Promise<WireMessage>((resolve) => {
      transport.subscribe(resolve);
    });

    win.incoming(
      encode(
        {
          type: 'INVOKE_RESPONSE',
          pluginId: 'core.health',
          event: 'health.ping',
          requestId: 'w3',
        },
        new Uint8Array([9, 8, 7]),
      ),
    );

    const message = await received;
    expect(message.header).toMatchObject({
      type: 'INVOKE_RESPONSE',
      requestId: 'w3',
    });
    expect(Array.from(message.payload)).toEqual([9, 8, 7]);
  });

  it('drains frames buffered by the injected stub before install', async () => {
    const win = installWindow();
    win.pending.push(
      new MessageProtocol().encode(
        MessageType.ENVELOPE,
        {
          type: 'DISPATCH',
          pluginId: 'core.health',
          event: 'health.ping',
        } as never,
        null,
      ),
    );

    const transport = createWkWebViewBridgeTransport();
    const received = new Promise<WireMessage>((resolve) => {
      transport.subscribe(resolve);
    });

    const message = await received;
    expect(message.header).toMatchObject({
      type: 'DISPATCH',
      event: 'health.ping',
    });
    expect(win.pending).toHaveLength(0);
  });
});
