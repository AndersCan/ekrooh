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
import { loadSelfValue, saveSelfValue } from './sync-values-file';

const parse = (raw: unknown) =>
  typeof raw === 'object' && raw !== null ? raw : undefined;

describe('sync values file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-values-file-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads back what it saved', () => {
    expect(saveSelfValue(dir, { tea: 2 })).toEqual([null, true]);
    expect(loadSelfValue(dir, parse)).toEqual({ tea: 2 });
    expect(fs.readdirSync(dir)).toEqual(['ekrooh-sync-values.json']);
  });

  it('starts empty and warns on a JSON null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, 'ekrooh-sync-values.json'), 'null');
    expect(loadSelfValue(dir, parse)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
