import { AsyncDirective, directive } from 'lit-html/async-directive.js';
import type { ReadableAtom } from 'nanostores';

/**
 * Bind a nanostores atom to a template slot.
 *
 * ONLY valid as a direct template expression — `${useStore($x)}` /
 * `${useStore($x, select)}` — where lit-html evaluates the directive inside
 * the `AsyncDirective` lifecycle and swaps the returned marker for the live
 * value. Do NOT assign the result to a variable and dereference it: the
 * returned object is a directive marker, so reading a field off it crashes
 * (`Cannot read properties of undefined`) or silently breaks the branch.
 *
 * To bind several atoms and read fields, derive one nanostores `computed`
 * view-model and consume it with a single binding:
 *
 * ```ts
 * const $vm = computed([$a, $b], (a, b) => ({ a, b }));
 * html`${useStore($vm, (vm) => body(vm))}`
 * ```
 */

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
