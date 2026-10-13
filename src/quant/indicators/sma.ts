import { assertFinite, assertPeriod, meanOf, type Series } from './common.js';

export const SMA_VERSION = 'sma:arithmetic:v1';

/**
 * Simple moving average: mean of the `period` values ending at each index.
 * Warm-up: indices 0 … period−2 are null. O(n): a running sum of deviations from a reference value,
 * re-summed exactly every `period` steps so floating-point drift cannot accumulate.
 */
export function sma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  assertFinite(values, 'sma input');
  const out: Series = new Array<number | null>(values.length).fill(null);
  if (values.length < period) return out;
  const k = values[0]!;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]! - k;
    if (i >= period) sum -= values[i - period]! - k;
    if (i >= period - 1) {
      if ((i + 1) % period === 0) {
        out[i] = meanOf(values, i - period + 1, i);
        sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += values[j]! - k;
      } else {
        out[i] = k + sum / period;
      }
    }
  }
  return out;
}
