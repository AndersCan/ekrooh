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

  it('login fail switches to the query-token URL', () => {
    const { m } = machine({ token: 'secret-token' });
    m.sendLoginFail();
    expect(m.state()).toBe('opening');
    expect(m.url()).toBe('ws://test/?token=secret-token');
  });

  it('close-before-open with a token retries the token URL immediately, consuming no retry', () => {
    const { m, clock } = machine({ token: 'secret-token' });
    m.sendLoginOk();
    m.sendClose();
    expect(m.state()).toBe('opening');
    expect(m.url()).toBe('ws://test/?token=secret-token');

    // The token-URL attempt also fails → normal backoff (token tried once).
    m.sendClose();
    expect(m.state()).toBe('backoff');
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
});
