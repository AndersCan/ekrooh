import { describe, expect, it } from 'vite-plus/test';
import { isPermissionId, PERMISSION_IDS } from './ids';

describe('permission ids', () => {
  it('knows the canonical ids and nothing else', () => {
    expect([...PERMISSION_IDS].sort()).toEqual(['camera', 'storage']);
    for (const id of PERMISSION_IDS) expect(isPermissionId(id)).toBe(true);
    for (const value of ['location', '', 'Camera', 42, null, undefined]) {
      expect(isPermissionId(value)).toBe(false);
    }
  });
});
