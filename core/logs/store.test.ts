import { describe, expect, it } from 'vite-plus/test';
import { createLogRingBuffer } from './store';

describe('createLogRingBuffer', () => {
  it('rejects non-positive capacities', () => {
    expect(() => createLogRingBuffer(0)).toThrow(RangeError);
    expect(() => createLogRingBuffer(-1)).toThrow(RangeError);
    expect(() => createLogRingBuffer(1.5)).toThrow(RangeError);
  });

  it('assigns a monotonic seq on append', () => {
    const store = createLogRingBuffer(10);
    store.append({ ts: 1, level: 'info', source: 'backend', message: 'a' });
    store.append({ ts: 2, level: 'warn', source: 'web', message: 'b' });
    expect(store.view().map((e) => e.seq)).toEqual([0, 1]);
  });

  it('drops the oldest once capacity is exceeded', () => {
    const store = createLogRingBuffer(2);
    store.append({ ts: 1, level: 'info', source: 'backend', message: 'a' });
    store.append({ ts: 2, level: 'info', source: 'backend', message: 'b' });
    store.append({ ts: 3, level: 'info', source: 'backend', message: 'c' });
    expect(store.view().map((e) => e.message)).toEqual(['b', 'c']);
    expect(store.capacity).toBe(2);
  });

  it('views newest-last bounded by tail', () => {
    const store = createLogRingBuffer(10);
    for (let i = 0; i < 5; i++)
      store.append({
        ts: i,
        level: 'info',
        source: 'backend',
        message: `m${i}`,
      });
    expect(store.view({ tail: 2 }).map((e) => e.message)).toEqual(['m3', 'm4']);
    expect(store.view().length).toBe(5);
  });

  it('filters by level and source', () => {
    const store = createLogRingBuffer(10);
    store.append({ ts: 0, level: 'debug', source: 'web', message: 'd' });
    store.append({ ts: 1, level: 'error', source: 'backend', message: 'e' });
    expect(store.view({ level: 'error' }).map((e) => e.message)).toEqual(['e']);
    expect(store.view({ source: 'web' }).map((e) => e.message)).toEqual(['d']);
  });

  it('stays ordered and bounded across several laps of the ring', () => {
    const store = createLogRingBuffer(3);
    for (let i = 0; i < 10; i++)
      store.append({
        ts: i,
        level: 'info',
        source: 'backend',
        message: `m${i}`,
      });
    expect(store.view().map((e) => e.message)).toEqual(['m7', 'm8', 'm9']);
    expect(store.view().map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(store.view({ tail: 2 }).map((e) => e.message)).toEqual(['m8', 'm9']);
  });

  it('works with a capacity of one', () => {
    const store = createLogRingBuffer(1);
    store.append({ ts: 1, level: 'info', source: 'backend', message: 'a' });
    store.append({ ts: 2, level: 'info', source: 'backend', message: 'b' });
    expect(store.view().map((e) => e.message)).toEqual(['b']);
  });

  it('keeps counting seq and ordering after clear on a wrapped ring', () => {
    const store = createLogRingBuffer(3);
    for (let i = 0; i < 5; i++)
      store.append({
        ts: i,
        level: 'info',
        source: 'backend',
        message: `m${i}`,
      });
    expect(store.clear()).toBe(3);
    store.append({ ts: 9, level: 'info', source: 'backend', message: 'x' });
    store.append({ ts: 10, level: 'info', source: 'backend', message: 'y' });
    expect(store.view().map((e) => [e.seq, e.message])).toEqual([
      [5, 'x'],
      [6, 'y'],
    ]);
  });

  it('clear empties the buffer and reports the count', () => {
    const store = createLogRingBuffer(10);
    store.append({ ts: 1, level: 'info', source: 'backend', message: 'a' });
    store.append({ ts: 2, level: 'info', source: 'backend', message: 'b' });
    expect(store.clear()).toBe(2);
    expect(store.view()).toEqual([]);
    expect(store.clear()).toBe(0);
  });
});
