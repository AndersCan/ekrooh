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

  it('applies full jitter within the backoff window', () => {
    const randoms: number[] = [];
    const { m, clock } = machine({
      maxRetries: 3,
      initialBackoffMs: 250,
      maxBackoffMs: 2000,
      // 0.5 → exactly half the exponential delay.
      random: () => {
        randoms.push(0.5);
        return 0.5;
      },
    });
    m.sendLoginOk();
    m.sendClose();
    expect(randoms).toHaveLength(1);
    // Capped exponential at retry 1 is 250ms; half of that is 125ms.
    expect(m.state()).toBe('backoff');
    clock.advance(124);
    expect(m.state()).toBe('backoff');
    clock.advance(1);
    expect(m.state()).toBe('opening');
  });
});
