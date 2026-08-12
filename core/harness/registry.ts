/**
 * The multi-instance dev harness registry — the state model validated in
 * ticket #5's prototype. Holds instance handles, tracks activity, reaps idle
 * instances after a timeout. Pure: time is passed in on every call so the
 * logic is deterministic and unit-testable without a runtime.
 */

export interface HarnessInstance<T> {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  /** Opaque handle (e.g. a `createWorkletRuntime` result). */
  runtime: T;
  /** Tear down the instance (close server, free resources). */
  destroy(): Promise<void> | void;
}

export interface HarnessRegistry<T = unknown> {
  list(): HarnessInstance<T>[];
  get(id: string): HarnessInstance<T> | undefined;
  /** Registers a fresh instance. Rejects a duplicate id. */
  register(instance: HarnessInstance<T>): void;
  /** Marks an instance active (WS connect/disconnect/request). */
  touch(id: string, now: number): void;
  /** Tears down and removes one instance. */
  destroy(id: string): Promise<void>;
  /** Tears down and removes every instance idle longer than `idleTimeoutMs`.
   * Returns the reaped ids. */
  reapDue(now: number, idleTimeoutMs: number): Promise<string[]>;
}

export function createHarnessRegistry<T = unknown>(): HarnessRegistry<T> {
  const instances = new Map<string, HarnessInstance<T>>();
  return {
    list() {
      return [...instances.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    get(id) {
      return instances.get(id);
    },
    register(instance) {
      if (instances.has(instance.id)) {
        throw new Error(`instance "${instance.id}" is already registered`);
      }
      instances.set(instance.id, instance);
    },
    touch(id, now) {
      const instance = instances.get(id);
      if (!instance) return;
      instance.lastActiveAt = now;
    },
    async destroy(id) {
      const instance = instances.get(id);
      if (!instance) return;
      instances.delete(id);
      await instance.destroy();
    },
    async reapDue(now, idleTimeoutMs) {
      const reaped: string[] = [];
      for (const instance of instances.values()) {
        if (now - instance.lastActiveAt >= idleTimeoutMs) {
          reaped.push(instance.id);
        }
      }
      for (const id of reaped) {
        await this.destroy(id);
      }
      return reaped;
    },
  };
}
