import { AsyncDirective, directive } from 'lit-html/async-directive.js';
import type { ReadableAtom } from 'nanostores';

class UseStoreDirective extends AsyncDirective {
  #unsub: (() => void) | undefined;
  #store: ReadableAtom<unknown> | undefined;
  #select: ((value: unknown) => unknown) | undefined;

  render<Value>(store: ReadableAtom<Value>): Value;
  render<Value, Selected>(
    store: ReadableAtom<Value>,
    select: (value: Value) => Selected,
  ): Selected;
  render<Value, Selected = Value>(
    store: ReadableAtom<Value>,
    select?: (value: Value) => Selected,
  ): Value | Selected {
    if (this.#store !== store || this.#select !== select) {
      this.#cleanup();
      this.#store = store;
      this.#select = select as ((value: unknown) => unknown) | undefined;
      if (this.isConnected) this.#subscribe();
    }
    const raw = store.get();
    return select ? select(raw) : raw;
  }

  #subscribe(): void {
    const store = this.#store;
    if (!store) return;
    const select = this.#select;
    this.#unsub = store.listen((value) => {
      this.setValue(select ? select(value) : value);
    });
  }

  #cleanup(): void {
    this.#unsub?.();
    this.#unsub = undefined;
  }

  protected override disconnected(): void {
    this.#cleanup();
  }

  protected override reconnected(): void {
    this.#subscribe();
  }
}

const useStoreDirective = directive(UseStoreDirective);

export function useStore<Value>(store: ReadableAtom<Value>): Value;
export function useStore<Value, Selected>(
  store: ReadableAtom<Value>,
  select: (value: Value) => Selected,
): Selected;
export function useStore<Value, Selected = Value>(
  store: ReadableAtom<Value>,
  select?: (value: Value) => Selected,
): Value | Selected {
  return useStoreDirective(store, select as (value: unknown) => unknown) as
    | Value
    | Selected;
}
