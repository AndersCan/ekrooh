/** Where a bounded writer sends frames: a stream whose `write` returns false
 * under pressure and emits `drain` once the reader has caught up. */
export type BoundedWriterTarget = {
  write(data: Uint8Array): boolean;
  on(event: 'drain', listener: () => void): unknown;
};

export type BoundedWriterOptions = {
  /** Most bytes queued behind a stalled reader before droppable frames are
   * shed. */
  maxQueuedBytes: number;
  /** Most bytes queued before a non-droppable frame is refused. Defaults to
   * 8x `maxQueuedBytes`. */
  hardMaxQueuedBytes?: number;
  /** Called once when a non-droppable frame cannot be queued; the owner
   * should close the connection rather than lose the frame silently. */
  onOverflow: () => void;
};

export type BoundedWriter = {
  /** Writes or queues a frame. Returns false when it was dropped or refused.
   * A `droppable` frame (a server push) is dropped when the queue is full,
   * newest first, so frames already queued are still delivered in order. A
   * non-droppable frame (a response) is queued past that limit, up to the hard
   * cap. */
  write(frame: Uint8Array, options?: { droppable?: boolean }): boolean;
  /** Frees the queue (the connection is gone). */
  clear(): void;
  readonly queuedBytes: number;
};

/** Honours `write() === false`: once the target signals pressure, frames queue
 * (bounded) until it drains instead of piling up inside the stream. */
export function createBoundedWriter(
  target: BoundedWriterTarget,
  options: BoundedWriterOptions,
): BoundedWriter {
  const hardMax = options.hardMaxQueuedBytes ?? options.maxQueuedBytes * 8;
  let queue: Uint8Array[] = [];
  let head = 0;
  let queued = 0;
  let blocked = false;
  let dead = false;
  let dropped = 0;

  function flush() {
    while (!blocked && head < queue.length) {
      const next = queue[head++];
      queued -= next.byteLength;
      if (!target.write(next)) blocked = true;
    }
    if (head === queue.length) {
      queue = [];
      head = 0;
    } else if (head > 1024) {
      queue = queue.slice(head);
      head = 0;
    }
    if (!blocked && dropped > 0) {
      console.warn(
        `[loopback] dropped ${dropped} push frame(s) while the client was not reading`,
      );
      dropped = 0;
    }
  }

  target.on('drain', () => {
    blocked = false;
    flush();
  });

  return {
    write(frame, writeOptions) {
      if (dead) return false;
      if (!blocked && head === queue.length) {
        if (!target.write(frame)) blocked = true;
        return true;
      }
      const size = frame.byteLength;
      if (writeOptions?.droppable) {
        if (queued + size > options.maxQueuedBytes) {
          if (dropped === 0) {
            console.warn(
              '[loopback] client is not reading; dropping push frames (newest first)',
            );
          }
          dropped++;
          return false;
        }
      } else if (queued > 0 && queued + size > hardMax) {
        dead = true;
        queue = [];
        head = 0;
        queued = 0;
        options.onOverflow();
        return false;
      }
      queue.push(frame);
      queued += size;
      return true;
    },
    clear() {
      queue = [];
      head = 0;
      queued = 0;
    },
    get queuedBytes() {
      return queued;
    },
  };
}

export type InboundGateOptions = {
  /** Pending work at which the inbound stream is paused. */
  high: number;
  /** Pending work at or below which it resumes. */
  low: number;
  pause(): void;
  resume(): void;
};

/** Pauses an inbound stream while too much routed work is pending, so a fast
 * sender cannot queue work faster than it completes. */
export function createInboundGate(options: InboundGateOptions) {
  let pending = 0;
  let paused = false;

  function done() {
    pending--;
    if (paused && pending <= options.low) {
      paused = false;
      options.resume();
    }
  }

  return {
    /** Counts `work` as pending until it settles. */
    track(work: Promise<unknown>) {
      pending++;
      if (!paused && pending >= options.high) {
        paused = true;
        options.pause();
      }
      work.then(done, done);
    },
    get pending() {
      return pending;
    },
  };
}
