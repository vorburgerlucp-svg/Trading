import { assertFinite, assertPeriod, type Series } from './common.js';

export const RSI_VERSION = 'rsi:wilder:v1';

/**
 * Relative Strength Index after Wilder.
 *   change_t = close_t − close_{t−1} (t ≥ 1); gain = max(change, 0), loss = max(−change, 0)
 *   first averages at t = period: arithmetic means of gains/losses over t = 1 … period
 *   then avg_t = (avg_{t−1}·(period − 1) + x_t) / period
 *   RSI = 100 − 100 / (1 + avgGain / avgLoss)
 * Special cases (no division by zero): only gains → 100; only losses → 0; no movement → 50 (neutral).
 * Warm-up: first value at index `period` (needs period + 1 closes).
 */
export function rsi(closes: readonly number[], period = 14): Series {
  assertPeriod(period);
  assertFinite(closes, 'rsi input');
  const out: Series = new Array<number | null>(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let t = 1; t <= period; t++) {
    const change = closes[t]! - closes[t - 1]!;
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = value(avgGain, avgLoss);
  for (let t = period + 1; t < closes.length; t++) {
    const change = closes[t]! - closes[t - 1]!;
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    out[t] = value(avgGain, avgLoss);
  }
  return out;
}

function value(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
