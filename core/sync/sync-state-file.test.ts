import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { loadSyncState, saveSyncState } from './sync-state-file';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-state-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const file = () => path.join(dir, 'ekrooh-sync.json');

describe('sync state file', () => {
  it('creates identity and room when missing, and reuses them', () => {
    const [e1, a] = loadSyncState(dir);
    expect(e1).toBeNull();
    expect(a?.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.room).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual(a);
    const [, b] = loadSyncState(dir);
    expect(b).toEqual(a);
  });

  it('warns and replaces a corrupt file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(file(), '{nope');
    const [error, state] = loadSyncState(dir);
    expect(error).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain('is unreadable');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual(state);
  });

  it('replaces a file with wrong field shapes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(
      file(),
      JSON.stringify({ version: 1, seed: 'x', room: 1 }),
    );
    const [error, state] = loadSyncState(dir);
    expect(error).toBeNull();
    expect(state?.seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a newer version and leaves the file untouched', () => {
    const text = JSON.stringify({ version: 2, seed: 'x', room: 'y' });
    fs.writeFileSync(file(), text);
    const [error, state] = loadSyncState(dir);
    expect(state).toBeNull();
    expect(error?.code).toBe('sync/state-version');
    expect(fs.readFileSync(file(), 'utf8')).toBe(text);
  });

  it('works in memory when the directory is unwritable or absent', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [e1, s1] = loadSyncState(path.join(dir, 'missing'));
    expect(e1).toBeNull();
    expect(s1?.room).toMatch(/^[0-9a-f]{32}$/);
    const [e2, s2] = loadSyncState(undefined);
    expect(e2).toBeNull();
    expect(s2?.seed).toHaveLength(64);
    expect(saveSyncState(undefined, s2!)).toBe(false);
  });
});
