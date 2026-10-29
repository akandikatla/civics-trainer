/**
 * Microsecond timing that works in the browser and in Node.
 *
 * Uses `performance.now()`, which is sub-millisecond in both environments. Browsers
 * coarsen it (often to 5-100 us) for privacy, so the last digits are approximate.
 */

export type Ticks = number;

export const startTimer = (): Ticks => performance.now();

/** Elapsed microseconds since `start`, rounded to the nearest whole us. */
export function elapsedUs(start: Ticks): number {
  return Math.round((performance.now() - start) * 1000);
}
