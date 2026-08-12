import { afterEach, describe, expect, it } from 'vite-plus/test';
import { getIPC } from './get-ipc';

type FakeIPC = { read(): null; write(): boolean; resume?(): void };

const g = globalThis as Record<string, unknown>;

function makeIPC(withResume: boolean): FakeIPC {
  return {
    read: () => null,
    write: () => true,
    ...(withResume ? { resume: () => {} } : {}),
  };
}

afterEach(() => {
  delete g.Bare;
  delete g.BareKit;
});

describe('getIPC', () => {
  it('prefers BareKit.IPC on the BareKit (Android) runtime', () => {
    const ipc = makeIPC(false);
    g.BareKit = { IPC: ipc };
    g.Bare = { IPC: makeIPC(false) };
    expect(getIPC()).toBe(ipc);
  });

  it('falls back to Bare.IPC on the Bare (Sidecar) runtime', () => {
    const ipc = makeIPC(false);
    g.Bare = { IPC: ipc };
    expect(getIPC()).toBe(ipc);
  });

  it('resumes a paused IPC channel', () => {
    let resumed = 0;
    const ipc = {
      read: () => null,
      write: () => true,
      resume: () => {
        resumed++;
      },
    };
    g.Bare = { IPC: ipc };
    expect(getIPC()).toBe(ipc);
    expect(resumed).toBe(1);
  });

  it('returns the channel when it has no resume', () => {
    const ipc = makeIPC(false);
    g.Bare = { IPC: ipc };
    expect(getIPC()).toBe(ipc);
  });

  it('passes through a null channel', () => {
    g.Bare = { IPC: null };
    expect(getIPC()).toBeNull();
  });
});
