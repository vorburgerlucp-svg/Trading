import { assertFinite, assertPeriod, meanOf, IndicatorError, type Series } from './common.js';

export const BOLLINGER_VERSION = 'bollinger:sma-population-stddev:v1';

export interface BollingerSeries {
  middle: Series;
  upper: Series;
  lower: Series;
  stdDev: Series;
  /** (close − lower) / (upper − lower); null when the bands collapse (upper = lower). */
  percentB: Series;
  /** (upper − lower) / middle; null when middle = 0. */
  bandwidth: Series;
}

/**
 * Bollinger Bands (default 20, 2):
 *   middle = SMA(period); σ = POPULATION standard deviation (divide by N, not N − 1) of the same window
 *   upper/lower = middle ± k·σ
 * Two-pass per window (mean, then squared deviations): exact zero width for constant input,
 * O(n·period), which is fine for the small periods used.
 */
export function bollinger(closes: readonly number[], period = 20, k = 2): BollingerSeries {
  assertPeriod(period);
  assertFinite(closes, 'bollinger input');
  if (!Number.isFinite(k) || k <= 0) throw new IndicatorError('bollinger multiplier must be positive');
  const n = closes.length;
  const empty = (): Series => new Array<number | null>(n).fill(null);
  const out: BollingerSeries = { middle: empty(), upper: empty(), lower: empty(), stdDev: empty(), percentB: empty(), bandwidth: empty() };
  for (let i = period - 1; i < n; i++) {
    const mean = meanOf(closes, i - period + 1, i);
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j]! - mean;
      ss += d * d;
    }
    const sd = Math.sqrt(ss / period);
    const upper = mean + k * sd;
    const lower = mean - k * sd;
    out.middle[i] = mean;
    out.stdDev[i] = sd;
    out.upper[i] = upper;
    out.lower[i] = lower;
    out.percentB[i] = upper === lower ? null : (closes[i]! - lower) / (upper - lower);
    out.bandwidth[i] = mean === 0 ? null : (upper - lower) / mean;
  }
  return out;
}
