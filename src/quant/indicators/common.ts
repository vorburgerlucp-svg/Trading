// Shared helpers for indicator math.
//
// Precision: indicators are statistics, computed in IEEE-754 float64 with only +, −, ×, ÷, abs and
// sqrt (all correctly rounded, therefore bit-for-bit deterministic on every platform; no Math.pow,
// exp or log). Prices enter as exact Decimals and are converted once. Results are normalized to
// 12 significant digits before they are stored or hashed. No money is ever booked from them.

export type Series = (number | null)[];

export class IndicatorError extends Error {
  override readonly name = 'IndicatorError';
}

export function assertPeriod(period: number, name = 'period'): void {
  if (!Number.isInteger(period) || period < 1 || period > 10_000) throw new IndicatorError(name + ' must be an integer between 1 and 10000, got ' + period);
}

export function assertFinite(values: readonly number[], name: string): void {
  for (const v of values) if (!Number.isFinite(v)) throw new IndicatorError(name + ' contains a non-finite value');
}

/** Canonical output number: 12 significant digits, no negative zero. */
export function qn(x: number): number {
  if (!Number.isFinite(x)) throw new IndicatorError('non-finite indicator output');
  const r = Number(x.toPrecision(12));
  return r === 0 ? 0 : r;
}

/**
 * Mean of values[from..to] (inclusive) computed around the first value: k + Σ(v−k)/n.
 * Exact for constant input and less prone to cancellation for large prices.
 */
export function meanOf(values: readonly number[], from: number, to: number): number {
  const k = values[from]!;
  let s = 0;
  for (let i = from; i <= to; i++) s += values[i]! - k;
  return k + s / (to - from + 1);
}

export function lastDefined(series: Series): { index: number; value: number } | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined) return { index: i, value: v };
  }
  return null;
}
