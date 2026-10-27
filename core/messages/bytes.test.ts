import { describe, expect, it } from 'vite-plus/test';
import { toBytes, toIpcChunk } from './bytes';

describe('toBytes', () => {
  it('passes a Uint8Array (and a Buffer) through without copying', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toBytes(bytes)).toBe(bytes);
    const buffer = Buffer.from([4, 5]);
    expect(toBytes(buffer)).toBe(buffer);
  });

  it('views an ArrayBuffer', () => {
    const ab = new Uint8Array([7, 8]).buffer;
    const view = toBytes(ab);
    expect(view.buffer).toBe(ab);
    expect([...view]).toEqual([7, 8]);
  });

  it('throws on non-binary data', () => {
    expect(() => toBytes('text')).toThrow(/expected binary data, got string/);
    expect(() => toBytes(null)).toThrow(/got null/);
  });
});

describe('toIpcChunk', () => {
  it('returns a Buffer view over the same memory', () => {
    const backing = new Uint8Array([0, 1, 2, 3]);
    const slice = backing.subarray(1, 3);
    const chunk = toIpcChunk(slice);
    expect(Buffer.isBuffer(chunk)).toBe(true);
    expect([...chunk]).toEqual([1, 2]);
    expect(chunk.buffer).toBe(backing.buffer);
  });

  it('passes a Buffer through', () => {
    const buffer = Buffer.from([1]);
    expect(toIpcChunk(buffer)).toBe(buffer);
  });
});
