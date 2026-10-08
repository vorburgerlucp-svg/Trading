import { IndicatorError, assertPeriod, meanOf, type Series } from './common.js';

export const EMA_VERSION = 'ema:sma-seed:v1';

/**
 * Exponential moving average, α = 2 / (period + 1).
 * Seeding (explicit, no library default): the first EMA value is the SMA of the first `period`
 * defined inputs, placed at the index of the last of them; afterwards ema_t = ema_{t−1} + α·(x_t − ema_{t−1}).
 * Leading nulls are skipped (used for the MACD signal line); a null after the first value is an error.
 * Warm-up: first value at (first defined index) + period − 1.
 */
export function ema(values: readonly (number | null)[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array<number | null>(values.length).fill(null);
  let first = 0;
  while (first < values.length && (values[first] === null || values[first] === undefined)) first++;
  const defined: number[] = [];
  for (let i = first; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) throw new IndicatorError('ema input must be finite after its first value');
    defined.push(v);
  }
  if (defined.length < period) return out;
  const alpha = 2 / (period + 1);
  let e = meanOf(defined, 0, period - 1);
  out[first + period - 1] = e;
  for (let j = period; j < defined.length; j++) {
    e = e + alpha * (defined[j]! - e);
    out[first + j] = e;
  }
  return out;
}
