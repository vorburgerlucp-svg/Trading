import { IndicatorError, assertFinite, assertPeriod, type Series } from './common.js';

export const ATR_VERSION = 'atr:wilder:v1';

export interface Hlc {
  high: readonly number[];
  low: readonly number[];
  close: readonly number[];
}

export function assertHlc(input: Hlc): void {
  if (input.high.length !== input.low.length || input.low.length !== input.close.length) throw new IndicatorError('high/low/close must have the same length');
  assertFinite(input.high, 'high');
  assertFinite(input.low, 'low');
  assertFinite(input.close, 'close');
}

/**
 * True range: max(high − low, |high − prevClose|, |low − prevClose|).
 * TR_0 is null: the first bar has no previous close (not substituted by high − low).
 */
export function trueRange(input: Hlc): Series {
  assertHlc(input);
  const out: Series = new Array<number | null>(input.close.length).fill(null);
  for (let t = 1; t < input.close.length; t++) {
    const h = input.high[t]!;
    const l = input.low[t]!;
    const pc = input.close[t - 1]!;
    out[t] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return out;
}

/**
 * Average True Range after Wilder (default 14):
 *   first ATR at index `period` = mean(TR_1 … TR_period)
 *   then ATR_t = (ATR_{t−1}·(period − 1) + TR_t) / period
 * Warm-up: needs period + 1 bars.
 */
export function atr(input: Hlc, period = 14): Series {
  assertPeriod(period);
  const tr = trueRange(input);
  const out: Series = new Array<number | null>(tr.length).fill(null);
  if (tr.length <= period) return out;
  let sum = 0;
  for (let t = 1; t <= period; t++) sum += tr[t]!;
  let a = sum / period;
  out[period] = a;
  for (let t = period + 1; t < tr.length; t++) {
    a = (a * (period - 1) + tr[t]!) / period;
    out[t] = a;
  }
  return out;
}
