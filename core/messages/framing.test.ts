import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { TextDecoder, TextEncoder } from 'node:util';
import { MessageType } from './constants';
import { MessageProtocol } from './wire-codec';
import { createFrameDecoder } from './framing';
import type { WireMessage } from './types';

const protocol = new MessageProtocol({
  encode: (str) => new TextEncoder().encode(str),
  decode: (bytes) => new TextDecoder().decode(bytes),
});

const requests = (msgs: WireMessage[]) =>
  msgs.map((m) => (m.header as { event: string }).event);

describe('createFrameDecoder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes a complete header-only frame in one push', () => {
    const decoder = createFrameDecoder(protocol);
    const frame = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.ping',
        requestId: '1',
        args: {},
      },
      null,
    );
    expect(requests(decoder.push(frame))).toEqual(['a.ping']);
    expect(decoder.push(new Uint8Array(0))).toEqual([]);
  });

  it('reassembles a frame split across arbitrary chunks', () => {
    const decoder = createFrameDecoder(protocol);
    const frame = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.ping',
        requestId: '2',
        args: {},
      },
      null,
    );
    const seen: WireMessage[] = [];
    for (let i = 0; i < frame.byteLength; i++) {
      seen.push(...decoder.push(frame.subarray(i, i + 1)));
    }
    expect(requests(seen)).toEqual(['a.ping']);
  });

  it('drains multiple coalesced frames from one chunk in order', () => {
    const decoder = createFrameDecoder(protocol);
    const f1 = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.one',
        requestId: '3',
        args: {},
      },
      null,
    );
    const f2 = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.two',
        requestId: '4',
        args: {},
      },
      null,
    );
    const both = new Uint8Array(f1.byteLength + f2.byteLength);
    both.set(f1, 0);
    both.set(f2, f1.byteLength);
    const decoded = decoder.push(both);
    expect(requests(decoded)).toEqual(['a.one', 'a.two']);
    expect(decoded[0].payload.byteLength).toBe(0);
  });

  it('reassembles a payload-bearing frame using the header-carried payload length', () => {
    const decoder = createFrameDecoder(protocol);
    const payload = new TextEncoder().encode('payload bytes');
    const frame = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.echo',
        requestId: '5',
        args: {},
      },
      payload,
    );
    // Split mid-payload: the decoder must wait for the declared payload length
    // before emitting the frame.
    const mid = frame.byteLength - 3;
    expect(decoder.push(frame.subarray(0, mid))).toEqual([]);
    const [decoded] = decoder.push(frame.subarray(mid));
    expect((decoded.header as { event: string }).event).toBe('a.echo');
    expect(new TextDecoder().decode(decoded.payload)).toBe('payload bytes');
  });

  it('does not corrupt a following frame after a payload-bearing one', () => {
    const decoder = createFrameDecoder(protocol);
    const payloadFrame = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.echo',
        requestId: '6',
        args: {},
      },
      new TextEncoder().encode('x'),
    );
    const next = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.ping',
        requestId: '7',
        args: {},
      },
      null,
    );
    const coalesced = new Uint8Array(payloadFrame.byteLength + next.byteLength);
    coalesced.set(payloadFrame, 0);
    coalesced.set(next, payloadFrame.byteLength);
    expect(requests(decoder.push(coalesced))).toEqual(['a.echo', 'a.ping']);
  });

  it('propagates decode errors for malformed frames', () => {
    const decoder = createFrameDecoder(protocol);
    // A ≥4-byte chunk whose version byte is invalid: the frame decodes (fails)
    // instantly — the caller decides to drop the channel, the decoder buffers
    // nothing.
    expect(() =>
      decoder.push(new Uint8Array([0xff, 0x00, 0x00, 0x00])),
    ).toThrow(/Unsupported version/);
  });

  it('records a framing error, goes inert, and clears on clear()', () => {
    const small = new MessageProtocol({
      maxFrameBytes: 1024,
      decode: (bytes) => new TextDecoder().decode(bytes),
      encode: (str) => new TextEncoder().encode(str),
    });
    const decoder = createFrameDecoder(small);
    const frame = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.ping',
        requestId: '8',
        args: {},
      },
      null,
    );

    // A header that declares an impossible payload length pushes frameLen past
    // the cap for this protocol.
    const header = new TextEncoder().encode(
      JSON.stringify({
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.ping',
        requestId: '9',
        args: {},
        payloadLength: 99999,
      }),
    );
    const prefix = new Uint8Array(4 + header.byteLength);
    prefix[0] = 1;
    prefix[1] = MessageType.ENVELOPE;
    prefix[2] = (header.byteLength >> 8) & 0xff;
    prefix[3] = header.byteLength & 0xff;
    prefix.set(header, 4);

    expect(() => decoder.push(prefix)).toThrow(/Frame too large/);
    expect(decoder.error).not.toBeNull();
    // After failure the decoder stays inert until cleared.
    expect(decoder.push(frame)).toEqual([]);
    decoder.clear();
    expect(decoder.push(frame).length).toBe(1);
  });
});
