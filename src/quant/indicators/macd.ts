import { IndicatorError, assertPeriod, type Series } from './common.js';
import { ema } from './ema.js';

export const MACD_VERSION = 'macd:ema-sma-seed:v1';

export interface MacdSeries {
  macd: Series;
  signal: Series;
  histogram: Series;
}

/**
 * MACD (default 12/26/9) built from the standalone SMA-seeded EMAs (see ema.ts):
 *   macd = EMA_fast(close) − EMA_slow(close)                       first at index slow − 1
 *   signal = EMA_signal(macd), seeded with the SMA of the first `signal` MACD values   first at slow + signal − 2
 *   histogram = macd − signal
 */
export function macd(closes: readonly number[], fast = 12, slow = 26, signal = 9): MacdSeries {
  assertPeriod(fast, 'fast');
  assertPeriod(slow, 'slow');
  assertPeriod(signal, 'signal');
  if (fast >= slow) throw new IndicatorError('MACD fast period must be shorter than the slow period');
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: Series = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i]! - es[i]! : null));
  const sig = ema(line, signal);
  const histogram: Series = line.map((m, i) => (m !== null && sig[i] !== null ? m - sig[i]! : null));
  return { macd: line, signal: sig, histogram };
}
