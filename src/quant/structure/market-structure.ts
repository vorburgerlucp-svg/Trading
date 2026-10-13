// Market structure from confirmed swings (structure:swing-hhll:v1).
//
// Each swing high is compared with the previous swing high: higher → HH, lower → LH, equal → EH.
// Each swing low with the previous swing low: higher → HL, lower → LL, equal → EL.
// Trend from the most recent labelled high and low:
//   HH + HL → bullish;  LH + LL → bearish;  any other combination → range;
//   fewer than two swing highs or two swing lows → unknown.
// BOS / CHOCH / liquidity sweeps are intentionally not part of V1.

import type { Decimal } from '../../money/decimal.js';

export const MARKET_STRUCTURE_VERSION = 'structure:swing-hhll:v1';

export type StructureLabel = 'HH' | 'LH' | 'EH' | 'HL' | 'LL' | 'EL';
export type StructureTrend = 'bullish' | 'bearish' | 'range' | 'unknown';

export interface StructureSwing {
  kind: 'high' | 'low';
  index: number;
  price: Decimal;
  time: string;
  confirmedAt: string;
}

export interface StructurePoint extends StructureSwing {
  label: StructureLabel;
}

export interface MarketStructure {
  trend: StructureTrend;
  lastHighLabel: StructureLabel | null;
  lastLowLabel: StructureLabel | null;
  points: StructurePoint[];
  reason: string;
}

export function marketStructure(swings: readonly StructureSwing[]): MarketStructure {
  const ordered = [...swings].sort((a, b) => a.index - b.index || (a.kind === b.kind ? 0 : a.kind === 'high' ? -1 : 1));
  const points: StructurePoint[] = [];
  let prevHigh: StructureSwing | null = null;
  let prevLow: StructureSwing | null = null;
  for (const s of ordered) {
    if (s.kind === 'high') {
      if (prevHigh) points.push({ ...s, label: s.price.gt(prevHigh.price) ? 'HH' : s.price.lt(prevHigh.price) ? 'LH' : 'EH' });
      prevHigh = s;
    } else {
      if (prevLow) points.push({ ...s, label: s.price.gt(prevLow.price) ? 'HL' : s.price.lt(prevLow.price) ? 'LL' : 'EL' });
      prevLow = s;
    }
  }
  const lastHigh = [...points].reverse().find((p) => p.kind === 'high')?.label ?? null;
  const lastLow = [...points].reverse().find((p) => p.kind === 'low')?.label ?? null;
  if (!lastHigh || !lastLow) return { trend: 'unknown', lastHighLabel: lastHigh, lastLowLabel: lastLow, points, reason: 'needs at least two confirmed swing highs and two swing lows' };
  if (lastHigh === 'HH' && lastLow === 'HL') return { trend: 'bullish', lastHighLabel: lastHigh, lastLowLabel: lastLow, points, reason: 'higher high and higher low' };
  if (lastHigh === 'LH' && lastLow === 'LL') return { trend: 'bearish', lastHighLabel: lastHigh, lastLowLabel: lastLow, points, reason: 'lower high and lower low' };
  return { trend: 'range', lastHighLabel: lastHigh, lastLowLabel: lastLow, points, reason: 'mixed swing sequence (' + lastHigh + ' / ' + lastLow + ')' };
}
