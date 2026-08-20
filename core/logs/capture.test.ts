import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { installConsoleCapture } from './capture';
import { createLogRingBuffer } from './store';

describe('installConsoleCapture', () => {
  const originals = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  afterEach(() => {
    console.debug = originals.debug;
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  });

  it('intercepts console calls and forwards to the originals', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createLogRingBuffer(10);
    const capture = installConsoleCapture(store, 'backend');

    console.log('hello', 42);
    expect(logSpy).toHaveBeenCalledWith('hello', 42);
    expect(store.view().map((e) => e.message)).toEqual(['hello 42']);
    expect(store.view()[0]?.level).toBe('info');

    capture.restore();
  });

  it('maps console methods to levels', () => {
    const store = createLogRingBuffer(10);
    const capture = installConsoleCapture(store, 'backend');
    console.error('boom');
    capture.restore();
    expect(store.view()[0]?.level).toBe('error');
  });

  it('does not break boot when the store append throws', () => {
    const badStore = {
      capacity: 1,
      append() {
        throw new Error('boom');
      },
      view: () => [],
      clear: () => 0,
    };
    const capture = installConsoleCapture(badStore, 'backend');
    expect(() => console.log('still works')).not.toThrow();
    capture.restore();
  });

  it('restore puts the original methods back', () => {
    const store = createLogRingBuffer(10);
    const capture = installConsoleCapture(store, 'web');
    capture.restore();
    expect(console.log).toBe(originals.log);
  });
});
