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

  it('does not alias decoded payloads to a reused caller-owned receive buffer', () => {
    const decoder = createFrameDecoder(protocol);
    const payload = new TextEncoder().encode('AAAA');
    const fA = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.ping',
        requestId: '9',
        args: {},
      },
      payload,
    );
    const fB = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.ping',
        requestId: '9',
        args: {},
      },
      new TextEncoder().encode('BBBB'),
    );
    // A single-frame-sized buffer the caller reuses for every read — the normal
    // socket/stream loop pattern. Sizing it to exactly one frame keeps the
    // decoder's internal buffer empty at the start of each push, which is the
    // exact condition under which concatBytes returns the caller's chunk by
    // reference.
    const reusable = new Uint8Array(fA.byteLength);

    reusable.set(fA);
    const [a] = decoder.push(reusable);

    // Reuse the same buffer for the next read before reading a's payload back.
    reusable.set(fB);
    const [b] = decoder.push(reusable);

    // a.payload must still read 'AAAA', not the bytes the caller wrote for the
    // next frame. Before the fix a.payload aliased `reusable` and read 'BBBB'.
    expect(new TextDecoder().decode(a.payload)).toBe('AAAA');
    expect(new TextDecoder().decode(b.payload)).toBe('BBBB');
  });

  describe('chunked reassembly', () => {
    const header = (event: string, requestId: string) =>
      ({
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event,
        requestId,
        args: {},
      }) as const;

    const pattern = (size: number, seed = 0) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
      return bytes;
    };

    it('reassembles a multi-megabyte payload delivered in 64KB chunks', () => {
      const decoder = createFrameDecoder(protocol);
      const payload = pattern(4 * 1024 * 1024);
      const frame = protocol.encode(
        MessageType.ENVELOPE,
        header('a.big', 'big'),
        payload,
      );
      const seen: WireMessage[] = [];
      for (let o = 0; o < frame.byteLength; o += 65536) {
        seen.push(...decoder.push(frame.subarray(o, o + 65536)));
      }
      expect(decoder.error).toBeNull();
      expect(seen).toHaveLength(1);
      expect(seen[0].payload.byteLength).toBe(payload.byteLength);
      expect(Buffer.compare(seen[0].payload, payload)).toBe(0);
    });

    it('keeps a trailing partial frame across pushes and decodes it intact', () => {
      const decoder = createFrameDecoder(protocol);
      const f1 = protocol.encode(
        MessageType.ENVELOPE,
        header('a.one', '1'),
        pattern(300, 1),
      );
      const f2 = protocol.encode(
        MessageType.ENVELOPE,
        header('a.two', '2'),
        pattern(70000, 2),
      );
      const f3 = protocol.encode(
        MessageType.ENVELOPE,
        header('a.three', '3'),
        null,
      );
      const stream = new Uint8Array(
        f1.byteLength + f2.byteLength + f3.byteLength,
      );
      stream.set(f1, 0);
      stream.set(f2, f1.byteLength);
      stream.set(f3, f1.byteLength + f2.byteLength);

      // Chunk sizes chosen so boundaries land inside a prefix, a header and a
      // payload, and several frames coalesce with a partial tail.
      const sizes = [5, 400, 1, 20000, 49000, 7];
      const seen: WireMessage[] = [];
      let o = 0;
      for (const size of sizes) {
        seen.push(...decoder.push(stream.subarray(o, o + size)));
        o += size;
      }
      seen.push(...decoder.push(stream.subarray(o)));
      expect(decoder.error).toBeNull();
      expect(requests(seen)).toEqual(['a.one', 'a.two', 'a.three']);
      expect(Buffer.compare(seen[0].payload, pattern(300, 1))).toBe(0);
      expect(Buffer.compare(seen[1].payload, pattern(70000, 2))).toBe(0);
    });

    it('does not alias a partial frame to a caller buffer that is reused', () => {
      const decoder = createFrameDecoder(protocol);
      const frame = protocol.encode(
        MessageType.ENVELOPE,
        header('a.ping', 'p'),
        new TextEncoder().encode('AAAA'),
      );
      const mid = frame.byteLength - 2;
      const reusable = new Uint8Array(mid);
      reusable.set(frame.subarray(0, mid));
      expect(decoder.push(reusable)).toEqual([]);
      // The caller scribbles over its buffer before the rest arrives.
      reusable.fill(0xee);
      const [decoded] = decoder.push(frame.subarray(mid));
      expect(new TextDecoder().decode(decoded.payload)).toBe('AAAA');
    });

    it('copies frames out of a Buffer chunk (Buffer#slice is a view)', () => {
      const decoder = createFrameDecoder(protocol);
      const frame = protocol.encode(
        MessageType.ENVELOPE,
        header('a.ping', 'b'),
        new TextEncoder().encode('AAAA'),
      );
      const chunk = Buffer.from(frame);
      const [decoded] = decoder.push(chunk);
      chunk.fill(0xee);
      expect(new TextDecoder().decode(decoded.payload)).toBe('AAAA');
    });

    it('frees a large partial buffer once drained and keeps working', () => {
      const decoder = createFrameDecoder(protocol);
      const big = protocol.encode(
        MessageType.ENVELOPE,
        header('a.big', 'x'),
        pattern(256 * 1024),
      );
      const small = protocol.encode(
        MessageType.ENVELOPE,
        header('a.small', 'y'),
        null,
      );
      expect(decoder.push(big.subarray(0, 1000))).toEqual([]);
      expect(requests(decoder.push(big.subarray(1000)))).toEqual(['a.big']);
      expect(requests(decoder.push(small))).toEqual(['a.small']);
    });
  });

  it('records a decode error, goes inert, and clears on clear()', () => {
    const decoder = createFrameDecoder(protocol);
    // A ≥7-byte chunk whose version byte is invalid: the frame fails to decode
    // instantly. The decoder goes inert and returns nothing (no throw), so the
    // caller checks `error` to decide whether to drop the channel.
    expect(
      decoder.push(new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
    ).toEqual([]);
    expect(decoder.error).not.toBeNull();
    // After failure the decoder stays inert until cleared.
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
    expect(decoder.push(frame)).toEqual([]);
    decoder.clear();
    expect(decoder.push(frame).length).toBe(1);
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

    // A binary payload length that pushes frameLen past the cap for this
    // protocol (headerLen 0, payloadLen 0xFFFFFE).
    const prefix = new Uint8Array([1, 1, 0, 0, 0xff, 0xff, 0xfe]);

    expect(decoder.push(prefix)).toEqual([]);
    expect(decoder.error).not.toBeNull();
    // After failure the decoder stays inert until cleared.
    expect(decoder.push(frame)).toEqual([]);
    decoder.clear();
    expect(decoder.push(frame).length).toBe(1);
  });

  it('does not discard already-decoded frames when a later frame in the same chunk fails', () => {
    const decoder = createFrameDecoder(protocol);
    const good = protocol.encode(
      MessageType.ENVELOPE,
      {
        type: 'INVOKE_REQUEST',
        pluginId: 'a',
        event: 'a.one',
        requestId: '10',
        args: {},
      },
      null,
    );
    const bad = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

    const coalesced = new Uint8Array(good.byteLength + bad.byteLength);
    coalesced.set(good, 0);
    coalesced.set(bad, good.byteLength);

    // The good frame must be returned before the decoder goes inert on the bad
    // frame — it must not be discarded by the later failure in the same chunk.
    const decoded = decoder.push(coalesced);
    expect(requests(decoded)).toEqual(['a.one']);
    expect(decoder.error).not.toBeNull();
  });
});
