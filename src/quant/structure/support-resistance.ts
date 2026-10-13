// Support / resistance from CONFIRMED swing levels (deterministic, no AI).
//
// Algorithm (sr:swing-cluster:v1):
//   1. take confirmed swings whose extreme lies within the last `lookbackBars` bars
//   2. sort by price (ties: bar index), greedy clustering: a swing joins the current cluster while
//      price − (lowest price of the cluster) ≤ tolerance; otherwise it starts a new cluster
//      (bounded cluster width, independent of input order)
//   3. a cluster with ≥ minTouches swings is a level: priceLevel = mean of its swing prices (exact
//      Decimal, rounded half-even to the price scale), touchCount, firstSeen/lastSeen (bar starts),
//      confirmedAt = when the minTouches-th touch was confirmed (the level exists from then on)
//   4. kind: below the reference (last close) → support, otherwise resistance
//   5. strengthScore ∈ [0, 1] = 0.6·min(1, touchCount/5) + 0.4·recency,
//      recency = max(0, 1 − barsSinceLastTouch / lookbackBars).
//      It is a quant score for ranking levels, NOT a probability.
// Complexity: O(S log S) for S swings (S ≤ number of bars).

import { Decimal } from '../../money/decimal.js';
import { qn } from '../indicators/common.js';

export const SUPPORT_RESISTANCE_VERSION = 'sr:swing-cluster:v1';

export interface SwingLevelInput {
  kind: 'high' | 'low';
  index: number;
  price: Decimal;
  /** Bar start of the extreme. */
  time: string;
  confirmedIndex: number;
  confirmedAt: string;
}

export interface SupportResistanceLevel {
  kind: 'support' | 'resistance';
  priceLevel: Decimal;
  touchCount: number;
  firstSeen: string;
  lastSeen: string;
  confirmedAt: string;
  strengthScore: number;
  touches: Array<{ kind: 'high' | 'low'; price: Decimal; time: string }>;
}

export interface SupportResistanceOptions {
  referencePrice: Decimal;
  tolerance: Decimal;
  minTouches: number;
  lookbackBars: number;
  lastIndex: number;
  priceScale: number;
}

export function supportResistance(swings: readonly SwingLevelInput[], o: SupportResistanceOptions): SupportResistanceLevel[] {
  const recent = swings.filter((s) => s.index > o.lastIndex - o.lookbackBars && s.confirmedIndex <= o.lastIndex);
  const sorted = [...recent].sort((a, b) => a.price.cmp(b.price) || a.index - b.index);
  const clusters: SwingLevelInput[][] = [];
  for (const s of sorted) {
    const current = clusters[clusters.length - 1];
    if (current && s.price.minus(current[0]!.price).lte(o.tolerance)) current.push(s);
    else clusters.push([s]);
  }
  const levels: SupportResistanceLevel[] = [];
  for (const c of clusters) {
    if (c.length < o.minTouches) continue;
    const sum = c.reduce((acc, s) => acc.plus(s.price), Decimal.ZERO);
    const priceLevel = sum.dividedBy(c.length, o.priceScale, 'half_even');
    const byTime = [...c].sort((a, b) => a.index - b.index);
    const byConfirmation = [...c].sort((a, b) => a.confirmedIndex - b.confirmedIndex || a.index - b.index);
    const lastTouch = byTime[byTime.length - 1]!;
    const barsSince = o.lastIndex - lastTouch.index;
    const recency = Math.max(0, 1 - barsSince / o.lookbackBars);
    levels.push({
      kind: priceLevel.lt(o.referencePrice) ? 'support' : 'resistance',
      priceLevel,
      touchCount: c.length,
      firstSeen: byTime[0]!.time,
      lastSeen: lastTouch.time,
      confirmedAt: byConfirmation[o.minTouches - 1]!.confirmedAt,
      strengthScore: qn(0.6 * Math.min(1, c.length / 5) + 0.4 * recency),
      touches: byTime.map((s) => ({ kind: s.kind, price: s.price, time: s.time })),
    });
  }
  return levels.sort((a, b) => a.priceLevel.cmp(b.priceLevel));
}
