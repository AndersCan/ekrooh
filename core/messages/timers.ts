// Internal to the message layer: not re-exported from `index.ts`.

/** Largest delay `setTimeout` honours. A larger one overflows its 32-bit
 * signed field and fires almost at once, turning a long deadline into an
 * immediate timeout. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A usable timer delay: `value` when it is a finite number above 0 (capped
 * at {@link MAX_TIMER_MS}), otherwise `fallback`. */
export function timerMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Math.min(fallback, MAX_TIMER_MS);
  }
  return Math.min(value, MAX_TIMER_MS);
}
