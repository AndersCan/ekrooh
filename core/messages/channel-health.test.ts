import { describe, it, expect } from 'vite-plus/test';
import { ChannelHealth } from './channel-health';

describe('ChannelHealth', () => {
  it('resets consecutive failures on a success', () => {
    const h = new ChannelHealth(3);
    expect(h.noteFailure()).toBe(false);
    expect(h.noteFailure()).toBe(false);
    h.noteSuccess();
    expect(h.failures).toBe(0);
    expect(h.isFatal).toBe(false);
  });

  it('becomes fatal only after maxConsecutiveFailures', () => {
    const h = new ChannelHealth(3);
    expect(h.noteFailure()).toBe(false);
    expect(h.noteFailure()).toBe(false);
    expect(h.noteFailure()).toBe(true);
    expect(h.isFatal).toBe(true);
    // Stays fatal.
    expect(h.noteFailure()).toBe(true);
  });

  it('tolerates an isolated failure without going fatal', () => {
    const h = new ChannelHealth(2);
    expect(h.noteFailure()).toBe(false);
    h.noteSuccess();
    expect(h.isFatal).toBe(false);
    expect(h.noteFailure()).toBe(false);
    expect(h.noteFailure()).toBe(true);
  });

  it('uses a default threshold of 5', () => {
    const h = new ChannelHealth();
    for (let i = 0; i < 4; i++) expect(h.noteFailure()).toBe(false);
    expect(h.noteFailure()).toBe(true);
    expect(h.isFatal).toBe(true);
  });
});
