import { describe, expect, it, vi } from 'vite-plus/test';
import { createLineReader, encodeSyncLine } from './wire';

describe('encodeSyncLine', () => {
  it('round trips a value as one line', () => {
    const [error, line] = encodeSyncLine({ tea: 2 });
    expect(error).toBeNull();
    expect(line).toBe('{"v":1,"value":{"tea":2}}\n');
  });

  it('accepts a value just under 16 KiB and rejects one over', () => {
    expect(encodeSyncLine('a'.repeat(16 * 1024 - 100))[0]).toBeNull();
    expect(encodeSyncLine('a'.repeat(16 * 1024))[0]?.code).toBe(
      'sync/value-too-large',
    );
  });

  it('rejects values that are not JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, BigInt(1), undefined, () => 1]) {
      expect(encodeSyncLine(value)[0]?.code).toBe('sync/not-json');
    }
  });
});

describe('createLineReader', () => {
  const make = (maxBytes = 64) => {
    const lines: string[] = [];
    const onOverflow = vi.fn();
    const reader = createLineReader({
      maxBytes,
      onLine: (l) => lines.push(l),
      onOverflow,
    });
    return { reader, lines, onOverflow };
  };

  it('splits several lines in one chunk', () => {
    const { reader, lines } = make();
    reader.push('a\nb\n');
    expect(lines).toEqual(['a', 'b']);
  });

  it('joins a line split across chunks', () => {
    const { reader, lines } = make();
    reader.push('hel');
    reader.push(Buffer.from('lo\nwor'));
    reader.push('ld\n');
    expect(lines).toEqual(['hello', 'world']);
  });

  it('keeps multi-byte characters split across chunks intact', () => {
    const { reader, lines } = make();
    const bytes = Buffer.from('é\n');
    reader.push(bytes.subarray(0, 1));
    reader.push(bytes.subarray(1));
    expect(lines).toEqual(['é']);
  });

  it('calls onOverflow once when a line passes the limit', () => {
    const { reader, lines, onOverflow } = make(8);
    reader.push('123456789');
    reader.push('more\n');
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  it('allows a complete long line chunk that ends in a newline within the limit', () => {
    const { reader, lines, onOverflow } = make(8);
    reader.push('12345678\n');
    expect(lines).toEqual(['12345678']);
    expect(onOverflow).not.toHaveBeenCalled();
  });
});
