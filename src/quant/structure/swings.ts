// Swing highs / lows (fractal pivots) with explicit confirmation time.
//
// A swing high at bar i needs `rightBars` later bars to be confirmed: it is KNOWN only once bar
// i + rightBars is available. Every swing therefore carries confirmedIndex and confirmedAt (the
// availableAt of the confirming bar). The detector only ever sees bars up to asOf, so a swing whose
// confirming bars lie after asOf cannot exist in a historical computation (classic look-ahead trap).
//
// Tie rule (deterministic): strictly above every bar on the left, at least as high as every bar on
// the right — the FIRST of several equal peaks is the swing. Mirror image for lows. O(n·(left + right)).

import { IndicatorError, assertFinite, assertPeriod } from '../indicators/common.js';

export const SWING_VERSION = 'swings:fractal-strict-left:v1';

export interface SwingPoint {
  kind: 'high' | 'low';
  /** Index of the extreme bar. */
  index: number;
  /** Index of the bar that confirms it (index + rightBars). */
  confirmedIndex: number;
}

export function findSwings(high: readonly number[], low: readonly number[], leftBars = 3, rightBars = 3): SwingPoint[] {
  assertPeriod(leftBars, 'leftBars');
  assertPeriod(rightBars, 'rightBars');
  if (high.length !== low.length) throw new IndicatorError('high and low must have the same length');
  assertFinite(high, 'high');
  assertFinite(low, 'low');
  const out: SwingPoint[] = [];
  for (let i = leftBars; i + rightBars < high.length; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - leftBars; j < i && (isHigh || isLow); j++) {
      if (high[j]! >= high[i]!) isHigh = false;
      if (low[j]! <= low[i]!) isLow = false;
    }
    for (let j = i + 1; j <= i + rightBars && (isHigh || isLow); j++) {
      if (high[j]! > high[i]!) isHigh = false;
      if (low[j]! < low[i]!) isLow = false;
    }
    if (isHigh) out.push({ kind: 'high', index: i, confirmedIndex: i + rightBars });
    if (isLow) out.push({ kind: 'low', index: i, confirmedIndex: i + rightBars });
  }
  return out;
}
