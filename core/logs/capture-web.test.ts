import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { installWebConsoleCapture } from './capture-web';

describe('installWebConsoleCapture', () => {
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

  it('forwards console calls and flushes a web batch to the ingest', () => {
    const ingest =
      vi.fn<
        (payload: {
          source: 'web';
          entries: Array<{ level: string; message: string }>;
        }) => void
      >();
    const capture = installWebConsoleCapture({
      ingest,
      flushIntervalMs: 0,
    });
    console.error('boom', new Error('x'));
    capture.flush();
    expect(ingest).toHaveBeenCalledWith({
      source: 'web',
      entries: [{ level: 'error', message: expect.stringContaining('boom') }],
    });
    capture.restore();
  });

  it('buffers until flushThreshold then flushes', () => {
    const ingest = vi.fn();
    const capture = installWebConsoleCapture({
      ingest,
      flushThreshold: 2,
      flushIntervalMs: 0,
    });
    console.log('a');
    expect(ingest).not.toHaveBeenCalled();
    console.log('b');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith({
      source: 'web',
      entries: [
        { level: 'info', message: 'a' },
        { level: 'info', message: 'b' },
      ],
    });
    capture.restore();
  });

  it('never lets a throwing ingest break the app', () => {
    const ingest = vi.fn(() => {
      throw new Error('net down');
    });
    const capture = installWebConsoleCapture({
      ingest,
      flushIntervalMs: 0,
    });
    expect(() => {
      console.log('x');
      capture.flush();
    }).not.toThrow();
    capture.restore();
  });

  it('restore puts the original methods back', () => {
    const capture = installWebConsoleCapture({ flushIntervalMs: 0 });
    capture.restore();
    expect(console.log).toBe(originals.log);
  });
});
