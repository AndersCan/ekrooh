import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createBoundedWriter, createInboundGate } from './backpressure';

const frame = (size: number, fill = 1) => new Uint8Array(size).fill(fill);

function stalledTarget() {
  let drain: () => void = () => {};
  let accepting = true;
  const written: Uint8Array[] = [];
  return {
    written,
    stall() {
      accepting = false;
    },
    /** The reader catches up: next writes are accepted and `drain` fires. */
    release() {
      accepting = true;
      drain();
    },
    target: {
      write(data: Uint8Array) {
        written.push(data);
        return accepting;
      },
      on(_event: 'drain', listener: () => void) {
        drain = listener;
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createBoundedWriter', () => {
  it('writes straight through while the target accepts', () => {
    const t = stalledTarget();
    const w = createBoundedWriter(t.target, {
      maxQueuedBytes: 100,
      onOverflow: vi.fn(),
    });
    expect(w.write(frame(10))).toBe(true);
    expect(w.write(frame(10))).toBe(true);
    expect(t.written).toHaveLength(2);
    expect(w.queuedBytes).toBe(0);
  });

  it('queues after write() === false and flushes in order on drain', () => {
    const t = stalledTarget();
    const w = createBoundedWriter(t.target, {
      maxQueuedBytes: 100,
      onOverflow: vi.fn(),
    });
    t.stall();
    w.write(frame(10, 1)); // accepted by the stream, but it signals pressure
    w.write(frame(10, 2));
    w.write(frame(10, 3));
    expect(t.written).toHaveLength(1);
    expect(w.queuedBytes).toBe(20);

    t.release();
    expect(t.written.map((f) => f[0])).toEqual([1, 2, 3]);
    expect(w.queuedBytes).toBe(0);
  });

  it('drops the newest push when the queue is full and keeps the older ones', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = stalledTarget();
    const w = createBoundedWriter(t.target, {
      maxQueuedBytes: 25,
      onOverflow: vi.fn(),
    });
    t.stall();
    w.write(frame(10, 1)); // written, now blocked
    expect(w.write(frame(10, 2), { droppable: true })).toBe(true);
    expect(w.write(frame(10, 3), { droppable: true })).toBe(true);
    expect(w.write(frame(10, 4), { droppable: true })).toBe(false); // over 25
    expect(w.write(frame(10, 5), { droppable: true })).toBe(false);

    t.release();
    expect(t.written.map((f) => f[0])).toEqual([1, 2, 3]);
  });

  it('reports drops through the log, once per episode and with the count', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = stalledTarget();
    const w = createBoundedWriter(t.target, {
      maxQueuedBytes: 10,
      onOverflow: vi.fn(),
    });
    t.stall();
    w.write(frame(10));
    w.write(frame(10), { droppable: true });
    for (let i = 0; i < 5; i++) w.write(frame(10), { droppable: true });
    expect(warn).toHaveBeenCalledTimes(1);

    t.release();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toMatch(/dropped 5 /);
  });

  it('never drops a non-droppable frame below the hard cap, even past the soft cap', () => {
    const t = stalledTarget();
    const w = createBoundedWriter(t.target, {
      maxQueuedBytes: 10,
      hardMaxQueuedBytes: 100,
      onOverflow: vi.fn(),
    });
    t.stall();
    w.write(frame(10, 1));
    for (let i = 2; i <= 6; i++) expect(w.write(frame(10, i))).toBe(true);
    t.release();
    expect(t.written.map((f) => f[0])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('calls onOverflow instead of dropping when a non-droppable frame passes the hard cap', () => {
    const onOverflow = vi.fn();
    const t = stalledTarget();
    const w = createBoundedWriter(t.target, {
      maxQueuedBytes: 10,
      hardMaxQueuedBytes: 30,
      onOverflow,
    });
    t.stall();
    w.write(frame(10));
    w.write(frame(10));
    w.write(frame(10));
    w.write(frame(10));
    expect(onOverflow).not.toHaveBeenCalled();
    expect(w.write(frame(10))).toBe(false);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it('keeps memory bounded under a sustained stall', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = stalledTarget();
    const w = createBoundedWriter(t.target, {
      maxQueuedBytes: 64 * 1024,
      onOverflow: vi.fn(),
    });
    t.stall();
    w.write(frame(1024));
    for (let i = 0; i < 10_000; i++) {
      w.write(frame(1024), { droppable: true });
    }
    expect(w.queuedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(t.written).toHaveLength(1);
  });

  it('releases the queue on clear()', () => {
    const t = stalledTarget();
    const w = createBoundedWriter(t.target, {
      maxQueuedBytes: 100,
      onOverflow: vi.fn(),
    });
    t.stall();
    w.write(frame(10));
    w.write(frame(10));
    w.clear();
    expect(w.queuedBytes).toBe(0);
    t.release();
    expect(t.written).toHaveLength(1);
  });
});

describe('createInboundGate', () => {
  function deferred() {
    let resolve: () => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('pauses at the high-water mark and resumes at the low-water mark', async () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const gate = createInboundGate({ high: 4, low: 2, pause, resume });
    const work = Array.from({ length: 4 }, deferred);

    work.slice(0, 3).forEach((d) => gate.track(d.promise));
    expect(pause).not.toHaveBeenCalled();
    gate.track(work[3].promise);
    expect(pause).toHaveBeenCalledTimes(1);

    work[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resume).not.toHaveBeenCalled(); // 3 pending, above low
    work[1].resolve();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(gate.pending).toBe(2);
  });

  it('pauses only once however much more work arrives', () => {
    const pause = vi.fn();
    const gate = createInboundGate({ high: 2, low: 1, pause, resume: vi.fn() });
    for (let i = 0; i < 10; i++) gate.track(new Promise(() => {}));
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('counts a rejected task as finished', async () => {
    const resume = vi.fn();
    const gate = createInboundGate({
      high: 1,
      low: 0,
      pause: vi.fn(),
      resume,
    });
    const d = deferred();
    gate.track(d.promise);
    d.reject(new Error('boom'));
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(gate.pending).toBe(0);
  });
});
