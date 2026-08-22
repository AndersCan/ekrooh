import { describe, expect, it } from 'vite-plus/test';
import { MessageProtocol } from './wire-codec';
import { MAX_FRAME_BYTES, MAX_HEADER_BYTES, MessageType } from './constants';
import type { MessageHeader, RuntimeTarget } from './types';

describe('MessageProtocol encode/decode', () => {
  it('round-trips type/header/payload', () => {
    const protocol = new MessageProtocol();
    const payload = new Uint8Array([1, 2, 3, 4]);

    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_RESPONSE',
        pluginId: 'core.health',
        event: 'health.ping',
        requestId: 'req-1',
      },
      payload,
    );
    const decoded = protocol.decode(encoded);

    expect(decoded.type).toBe(MessageType.ENVELOPE);
    expect(decoded.header).toEqual({
      type: 'INVOKE_RESPONSE',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'req-1',
    });
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4]);
  });

  it('encodes string payloads as UTF-8', () => {
    const protocol = new MessageProtocol();
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      'hello',
    );
    const decoded = protocol.decode(encoded);
    expect(Array.from(decoded.payload)).toEqual([104, 101, 108, 108, 111]);
  });

  it('encodes ArrayBuffer payloads', () => {
    const protocol = new MessageProtocol();
    const buffer = new Uint8Array([9, 8, 7]).buffer;
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      buffer,
    );
    const decoded = protocol.decode(encoded);
    expect(Array.from(decoded.payload)).toEqual([9, 8, 7]);
  });

  it('encodes a null payload as zero bytes', () => {
    const protocol = new MessageProtocol();
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      null,
    );
    const decoded = protocol.decode(encoded);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it('rejects unsupported version', () => {
    const protocol = new MessageProtocol();
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      null,
    );
    encoded[0] = 99;
    expect(() => protocol.decode(encoded)).toThrow(/Unsupported version/);
  });

  it('rejects unknown message type by default', () => {
    const protocol = new MessageProtocol();
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      null,
    );
    encoded[1] = 250;
    expect(() => protocol.decode(encoded)).toThrow(/Unsupported message type/);
  });

  it('allows unknown message types when allowUnknownTypes is set', () => {
    const protocol = new MessageProtocol({ allowUnknownTypes: true });
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      null,
    );
    encoded[1] = 250;
    expect(() => protocol.decode(encoded)).not.toThrow();
  });

  it('rejects non-plugin header types', () => {
    const protocol = new MessageProtocol();
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'SET_HOME' } as never,
      null,
    );
    expect(() => protocol.decode(encoded)).toThrow(/Unsupported header type/);
  });

  it('rejects messages shorter than the header length field', () => {
    const protocol = new MessageProtocol();
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'core.health', event: 'health.ping' },
      null,
    );
    expect(() => protocol.decode(encoded.subarray(0, 6))).toThrow(/too short/);
  });

  it('round-trips host capabilities response header', () => {
    const protocol = new MessageProtocol();
    const header = {
      type: 'HOST_CAPABILITIES_RESPONSE' as const,
      requestId: 'host-cap-1',
      capabilities: [
        {
          pluginId: 'core.permissions',
          capabilities: [] as string[],
          events: ['permissions.requestStorage'],
          runtimes: ['android'] as RuntimeTarget[],
        },
      ],
    };
    const encoded = protocol.encode(MessageType.ENVELOPE, header, null);
    const decoded = protocol.decode(encoded);
    expect(decoded.header).toEqual({
      type: 'HOST_CAPABILITIES_RESPONSE',
      requestId: 'host-cap-1',
      capabilities: [
        {
          pluginId: 'core.permissions',
          capabilities: [],
          events: ['permissions.requestStorage'],
          runtimes: ['android'],
        },
      ],
    });
  });

  it('drops malformed capability rows', () => {
    const protocol = new MessageProtocol();
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'HOST_CAPABILITIES_RESPONSE',
        requestId: 'host-cap-2',
        capabilities: [
          {
            pluginId: 'a.plugin',
            capabilities: [1],
            events: 'nope',
            runtimes: ['bogus'],
          },
          { pluginId: 42 },
        ],
      } as unknown as MessageHeader,
      null,
    );
    const decoded = protocol.decode(encoded);
    expect(decoded.header).toEqual({
      type: 'HOST_CAPABILITIES_RESPONSE',
      requestId: 'host-cap-2',
      capabilities: [
        { pluginId: 'a.plugin', capabilities: [], events: [], runtimes: [] },
      ],
    });
  });

  it('rejects a header larger than the 16-bit length field', () => {
    const protocol = new MessageProtocol();
    const header = {
      type: 'DISPATCH',
      pluginId: 'core.health',
      event: 'health.ping',
      args: { blob: 'x'.repeat(0x10000) },
    } satisfies MessageHeader;
    expect(() => protocol.encode(MessageType.ENVELOPE, header, null)).toThrow(
      /Header too large/,
    );
  });

  it('rejects frames larger than the configured maximum', () => {
    const protocol = new MessageProtocol({ maxFrameBytes: 70000 });
    const payload = new Uint8Array(120000);
    expect(() =>
      protocol.encode(
        MessageType.ENVELOPE,
        { type: 'DISPATCH', pluginId: 'a.b', event: 'e' },
        payload,
      ),
    ).toThrow(/Frame too large/);
  });

  it('rejects oversized frames on decode', () => {
    const protocol = new MessageProtocol();
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'a.b', event: 'e' },
      new Uint8Array(MAX_FRAME_BYTES - 100),
    );
    const small = new MessageProtocol({ maxFrameBytes: 65540 });
    expect(() => small.decode(encoded)).toThrow(/Frame too large/);
  });

  it('round-trips frames within the default maximum', () => {
    const protocol = new MessageProtocol();
    const payload = new Uint8Array(MAX_FRAME_BYTES - 128);
    const encoded = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'a.b', event: 'e' },
      payload,
    );
    const decoded = protocol.decode(encoded);
    expect(decoded.payload.byteLength).toBe(MAX_FRAME_BYTES - 128);
  });

  it('drops unknown and prototype-polluting header fields on decode', () => {
    const protocol = new MessageProtocol();
    const header = {
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'req-fwd',
      futureField: { nested: true },
      __proto__: { polluted: true },
    } as unknown as MessageHeader;
    const decoded = protocol.decode(
      protocol.encode(MessageType.ENVELOPE, header, null),
    );
    expect(decoded.header).toEqual({
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'req-fwd',
    });
    expect(
      (decoded.header as Record<string, unknown>).futureField,
    ).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('throws FRAME_INVALID on invalid UTF-8 in the header frame', () => {
    const protocol = new MessageProtocol();
    const good = protocol.encode(
      MessageType.ENVELOPE,
      { type: 'DISPATCH', pluginId: 'a.b', event: 'e' },
      null,
    );
    const bad = new Uint8Array(good);
    bad[5] = 0xff;
    bad[6] = 0xfe;
    expect(() => protocol.decode(bad)).toThrow(/FRAME_INVALID/);
  });

  it('clamps an out-of-range maxFrameBytes to safe bounds', () => {
    expect(new MessageProtocol({ maxFrameBytes: 64 }).maxFrameBytes).toBe(
      MAX_HEADER_BYTES + 4,
    );
    expect(new MessageProtocol({ maxFrameBytes: 0 }).maxFrameBytes).toBe(
      MAX_HEADER_BYTES + 4,
    );
    expect(
      new MessageProtocol({ maxFrameBytes: Number.NEGATIVE_INFINITY })
        .maxFrameBytes,
    ).toBe(MAX_FRAME_BYTES);
    expect(
      new MessageProtocol({ maxFrameBytes: Number.NaN }).maxFrameBytes,
    ).toBe(MAX_FRAME_BYTES);
    expect(
      new MessageProtocol({ maxFrameBytes: Number.POSITIVE_INFINITY })
        .maxFrameBytes,
    ).toBe(MAX_FRAME_BYTES);
  });

  it('strips prototype-polluting keys from args and result', () => {
    const protocol = new MessageProtocol();
    const header = {
      type: 'INVOKE_RESPONSE',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'req-strip',
      result: {
        ok: true,
        __proto__: { polluted: true },
        nested: { constructor: { polluted: true } },
      },
    } as unknown as MessageHeader;
    const decoded = protocol.decode(
      protocol.encode(MessageType.ENVELOPE, header, null),
    );
    const result = (decoded.header as { result: Record<string, unknown> })
      .result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.__proto__).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    const nested = result.nested as Record<string, unknown> | undefined;
    expect(nested).toBeDefined();
    expect(nested?.constructor).toBeUndefined();
  });

  it('throws FRAME_INVALID on over-deep args (depth bomb)', () => {
    const protocol = new MessageProtocol();
    let bomb: unknown = { leaf: true };
    for (let i = 0; i < 40; i++) {
      bomb = { nested: bomb };
    }
    const header = {
      type: 'INVOKE_REQUEST',
      pluginId: 'core.health',
      event: 'health.ping',
      requestId: 'req-deep',
      args: bomb,
    } as unknown as MessageHeader;
    expect(() =>
      protocol.decode(protocol.encode(MessageType.ENVELOPE, header, null)),
    ).toThrow(/FRAME_INVALID/);
  });
});
