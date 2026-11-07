import { describe, expect, it } from 'vite-plus/test';
import { VirtualClock } from '@mantaq/core';
import { createConnectionMachine } from './connection-machine';

function machine(
  overrides: Partial<Parameters<typeof createConnectionMachine>[0]> = {},
) {
  const clock = new VirtualClock();
  const m = createConnectionMachine({
    url: 'ws://test',
    maxRetries: 3,
    initialBackoffMs: 250,
    maxBackoffMs: 2000,
    clock,
    // Deterministic jitter (full = capped delay) so the timings below are
    // exact; production passes no `random` and gets real `Math.random`.
    random: () => 1,
    // Give up on the retry count alone unless a test opts into the window.
    minBootWindowMs: 0,
    ...overrides,
  });
  return { m, clock };
}

describe('connection-machine', () => {
  it('starts idle; login ok opens, socket open connects', () => {
    const { m } = machine();
    expect(m.state()).toBe('idle');
    m.sendLoginOk();
    expect(m.state()).toBe('opening');
    expect(m.url()).toBe('ws://test');
    m.sendOpen();
    expect(m.state()).toBe('connected');
  });

  it('login fail fails the queue and never opens a socket (no token-URL fallback)', () => {
    const { m } = machine();
    m.sendLoginFail();
    expect(m.state()).toBe('gaveUp');
    expect(m.isGaveUp()).toBe(true);
  });

  it('close-before-open backs off on the same URL (no token-URL retry)', () => {
    const { m, clock } = machine();
    m.sendLoginOk();
    m.sendClose();
    expect(m.state()).toBe('backoff');
    expect(m.url()).toBe('ws://test');
    clock.advance(250);
    expect(m.state()).toBe('opening');
  });

  it('backs off exponentially (virtual clock) and reopens', () => {
    const { m, clock } = machine();
    m.sendLoginOk();
    m.sendClose();
    expect(m.state()).toBe('backoff');

    clock.advance(249);
    expect(m.state()).toBe('backoff');
    clock.advance(1);
    expect(m.state()).toBe('opening');

    // Second failure backs off at 2x.
    m.sendClose();
    expect(m.state()).toBe('backoff');
    clock.advance(499);
    expect(m.state()).toBe('backoff');
    clock.advance(1);
    expect(m.state()).toBe('opening');
  });

  it('reconnects after a post-open close and resets retries on open', () => {
    const { m, clock } = machine();
    m.sendLoginOk();
    m.sendOpen();
    expect(m.state()).toBe('connected');
    m.sendClose();
    expect(m.state()).toBe('backoff');
    clock.advance(250);
    expect(m.state()).toBe('opening');
    m.sendOpen();
    expect(m.state()).toBe('connected');
  });

  it('gives up after the retry cap', () => {
    const { m, clock } = machine({ maxRetries: 1 });
    m.sendLoginOk();
    m.sendClose();
    clock.advance(250);
    expect(m.state()).toBe('opening');
    m.sendClose();
    expect(m.state()).toBe('gaveUp');
    expect(m.isGaveUp()).toBe(true);
  });

  it('caps the backoff at maxBackoffMs', () => {
    const { m, clock } = machine({
      maxRetries: 5,
      initialBackoffMs: 1000,
      maxBackoffMs: 1500,
    });
    m.sendLoginOk();
    for (let i = 0; i < 4; i++) {
      m.sendClose();
      clock.advance(2000);
      expect(m.state()).toBe('opening');
    }
    // The 4th retry's backoff is capped at 1500ms (2^3=8000 → capped).
    m.sendClose();
    expect(m.state()).toBe('backoff');
    clock.advance(1499);
    expect(m.state()).toBe('backoff');
    clock.advance(1);
    expect(m.state()).toBe('opening');
  });

  it('notifies the shell on real changes (stray closes in backoff are ignored)', () => {
    const { m } = machine();
    const seen: string[] = [];
    m.onChange((s) => seen.push(s));
    m.sendLoginOk();
    m.sendOpen();
    m.sendClose();
    m.sendClose(); // already in backoff: defensive no-op, no change
    expect(seen).toEqual(['idle', 'opening', 'connected', 'backoff']);
  });

  it('applies equal jitter within the backoff window', () => {
    const randoms: number[] = [];
    const { m, clock } = machine({
      maxRetries: 3,
      initialBackoffMs: 250,
      maxBackoffMs: 2000,
      // 0.5 → half fixed (125ms) + half of the random half (62.5ms).
      random: () => {
        randoms.push(0.5);
        return 0.5;
      },
    });
    m.sendLoginOk();
    m.sendClose();
    expect(randoms).toHaveLength(1);
    expect(m.state()).toBe('backoff');
    clock.advance(186);
    expect(m.state()).toBe('backoff');
    clock.advance(1);
    expect(m.state()).toBe('opening');
  });

  it('never retries at ~0ms, however small the random draw (D-3)', () => {
    const { m, clock } = machine({ random: () => 0 });
    m.sendLoginOk();
    m.sendClose();
    clock.advance(124);
    expect(m.state()).toBe('backoff');
    clock.advance(1);
    expect(m.state()).toBe('opening');
  });

  describe('boot window (D-3)', () => {
    it('does not give up before minBootWindowMs even with the retries spent', () => {
      const { m, clock } = machine({
        maxRetries: 1,
        minBootWindowMs: 10_000,
        random: () => 0,
      });
      m.sendLoginOk();
      for (let i = 0; i < 20 && clock.now() < 9_000; i++) {
        m.sendClose();
        expect(m.state()).toBe('backoff');
        clock.advance(2000);
      }
      clock.advance(10_000);
      m.sendClose();
      expect(m.state()).toBe('gaveUp');
    });

    it('wake leaves gaveUp for idle with a fresh retry budget', () => {
      const { m, clock } = machine({ maxRetries: 0 });
      m.sendLoginOk();
      m.sendClose();
      expect(m.state()).toBe('gaveUp');
      m.sendWake();
      expect(m.state()).toBe('idle');
      m.sendLoginOk();
      expect(m.state()).toBe('opening');
      clock.advance(1);
      m.sendOpen();
      expect(m.state()).toBe('connected');
    });

    it('wake also leaves a login give-up', () => {
      const { m } = machine();
      m.sendLoginFail();
      m.sendWake();
      expect(m.state()).toBe('idle');
    });
  });

  describe('flapping sockets (D-2)', () => {
    it('does not reset retries until the socket stayed open for stableMs', () => {
      const { m, clock } = machine({ maxRetries: 3, stableMs: 5000 });
      m.sendLoginOk();
      // Open and drop at once, repeatedly: the backoff keeps growing.
      const delays: number[] = [];
      for (let i = 0; i < 4; i++) {
        m.sendOpen();
        m.sendClose();
        let waited = 0;
        while (m.state() === 'backoff') {
          clock.advance(50);
          waited += 50;
        }
        delays.push(waited);
      }
      expect(delays).toEqual([250, 500, 1000, 2000]);
      expect(m.isDegraded()).toBe(true);
    });

    it('resets retries once the socket has been stable', () => {
      const { m, clock } = machine({ maxRetries: 3, stableMs: 5000 });
      m.sendLoginOk();
      m.sendOpen();
      m.sendClose();
      clock.advance(250);
      m.sendOpen();
      clock.advance(5000);
      m.sendClose();
      clock.advance(249);
      expect(m.state()).toBe('backoff');
      clock.advance(1);
      expect(m.state()).toBe('opening');
    });

    it('waits replacedBackoffMs after a 4001 replacement, or a wake', () => {
      const { m, clock } = machine({ replacedBackoffMs: 30_000 });
      m.sendLoginOk();
      m.sendOpen();
      m.sendReplaced();
      expect(m.state()).toBe('backoff');
      expect(m.isReplaced()).toBe(true);
      clock.advance(29_999);
      expect(m.state()).toBe('backoff');
      clock.advance(1);
      expect(m.state()).toBe('opening');
      m.sendOpen();
      expect(m.isReplaced()).toBe(false);
      m.sendReplaced();
      m.sendWake();
      expect(m.state()).toBe('opening');
    });
  });

  it('treats a socket stuck in opening past openTimeoutMs as failed', () => {
    const { m, clock } = machine({ openTimeoutMs: 10_000 });
    m.sendLoginOk();
    clock.advance(9_999);
    expect(m.state()).toBe('opening');
    clock.advance(1);
    expect(m.state()).toBe('backoff');
  });

  it('stop is final from any state and cancels pending timers', () => {
    const { m, clock } = machine();
    m.sendLoginOk();
    m.sendClose();
    m.sendStop();
    expect(m.state()).toBe('closed');
    clock.advance(10_000);
    expect(m.state()).toBe('closed');
    m.sendWake();
    m.sendLoginOk();
    expect(m.isClosed()).toBe(true);
  });

  describe('after a successful connect', () => {
    it('never gives up: backs off past maxRetries consecutive failures', () => {
      const { m, clock } = machine({ maxRetries: 3 });
      m.sendLoginOk();
      m.sendOpen();
      m.sendClose();
      for (let i = 0; i < 10; i++) {
        expect(m.state()).toBe('backoff');
        clock.advance(2000);
        expect(m.state()).toBe('opening');
        m.sendClose();
      }
      expect(m.isGaveUp()).toBe(false);
      expect(m.state()).toBe('backoff');
    });

    it('still gives up at the cap when it never connected', () => {
      const { m, clock } = machine({ maxRetries: 3 });
      m.sendLoginOk();
      for (let i = 0; i < 3; i++) {
        m.sendClose();
        clock.advance(2000);
      }
      m.sendClose();
      expect(m.isGaveUp()).toBe(true);
    });

    it('stays capped at maxBackoffMs however many retries pile up', () => {
      const { m, clock } = machine({ maxRetries: 1 });
      m.sendLoginOk();
      m.sendOpen();
      for (let i = 0; i < 2000; i++) {
        m.sendClose();
        clock.advance(2000);
      }
      m.sendClose();
      expect(m.state()).toBe('backoff');
      clock.advance(2000);
      expect(m.state()).toBe('opening');
    });

    it('reports degraded once failures pass maxRetries, and clears on open', () => {
      const { m, clock } = machine({ maxRetries: 2 });
      m.sendLoginOk();
      m.sendOpen();
      expect(m.isDegraded()).toBe(false);
      for (let i = 0; i < 3; i++) {
        m.sendClose();
        clock.advance(2000);
      }
      m.sendClose();
      expect(m.isDegraded()).toBe(true);
      clock.advance(2000);
      m.sendOpen();
      expect(m.isDegraded()).toBe(false);
    });

    it('never reports degraded before the first connect', () => {
      const { m } = machine({ maxRetries: 1 });
      m.sendLoginOk();
      m.sendClose();
      expect(m.isDegraded()).toBe(false);
    });
  });

  describe('wake (app returns to the foreground)', () => {
    it('retries immediately instead of waiting out the backoff', () => {
      const { m, clock } = machine();
      m.sendLoginOk();
      m.sendOpen();
      m.sendClose();
      expect(m.state()).toBe('backoff');
      m.sendWake();
      expect(m.state()).toBe('opening');
      // The pending backoff timer must not open a second socket.
      let changes = 0;
      m.onChange(() => changes++);
      changes = 0; // subscribing replays the current state
      clock.advance(5000);
      expect(m.state()).toBe('opening');
      expect(changes).toBe(0);
    });

    it('is a no-op while connected, opening, idle or gave up', () => {
      const { m } = machine();
      m.sendWake();
      expect(m.state()).toBe('idle');
      m.sendLoginOk();
      m.sendWake();
      expect(m.state()).toBe('opening');
      m.sendOpen();
      m.sendWake();
      expect(m.state()).toBe('connected');
    });
  });
});
