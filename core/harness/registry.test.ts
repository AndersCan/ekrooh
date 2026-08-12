import { describe, expect, it } from 'vite-plus/test';
import { createHarnessRegistry } from './registry';

function instance(id: string, now: number, destroyed: string[] = []) {
  return {
    id,
    createdAt: now,
    lastActiveAt: now,
    runtime: {},
    destroy: () => {
      destroyed.push(id);
    },
  };
}

describe('createHarnessRegistry', () => {
  it('registers, lists in creation order, and rejects duplicate ids', () => {
    const r = createHarnessRegistry();
    r.register(instance('a', 1));
    r.register(instance('b', 2));
    expect(r.list().map((i) => i.id)).toEqual(['a', 'b']);
    expect(() => r.register(instance('a', 3))).toThrow(/already registered/);
  });

  it('touch updates lastActiveAt', () => {
    const r = createHarnessRegistry();
    r.register(instance('a', 0));
    r.touch('a', 1000);
    expect(r.get('a')?.lastActiveAt).toBe(1000);
  });

  it('destroy removes the instance and runs its teardown', async () => {
    const destroyed: string[] = [];
    const r = createHarnessRegistry();
    r.register(instance('a', 0, destroyed));
    await r.destroy('a');
    expect(r.get('a')).toBeUndefined();
    expect(destroyed).toEqual(['a']);
  });

  it('reapDue removes only instances idle past the timeout', async () => {
    const destroyed: string[] = [];
    const r = createHarnessRegistry();
    r.register(instance('idle', 0, destroyed));
    r.register(instance('fresh', 1000, destroyed));
    const reaped = await r.reapDue(1001, 1000);
    expect(reaped).toEqual(['idle']);
    expect(r.get('idle')).toBeUndefined();
    expect(r.get('fresh')).toBeDefined();
    expect(destroyed).toEqual(['idle']);
  });
});
