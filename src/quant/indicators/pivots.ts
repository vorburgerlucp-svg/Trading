// Pivot points from the PREVIOUS COMPLETED period (never the current, still forming session).
// Computed exactly with Decimal: only P needs a division (by 3), rounded half-even to the input
// scale + 4 decimals; everything else is exact addition/multiplication.

import { Decimal } from '../../money/decimal.js';

export const PIVOT_CLASSIC_VERSION = 'pivots:classic:v1';
export const PIVOT_FIBONACCI_VERSION = 'pivots:fibonacci:v1';
export const PIVOT_EXTRA_SCALE = 4;

export interface PivotBasis {
  high: Decimal;
  low: Decimal;
  close: Decimal;
}

export interface PivotLevels {
  p: Decimal;
  r1: Decimal;
  r2: Decimal;
  r3: Decimal;
  s1: Decimal;
  s2: Decimal;
  s3: Decimal;
}

export function pivotPoint(basis: PivotBasis): Decimal {
  const scale = Math.max(basis.high.scale, basis.low.scale, basis.close.scale) + PIVOT_EXTRA_SCALE;
  return basis.high.plus(basis.low).plus(basis.close).dividedBy(3, scale, 'half_even');
}

/** Classic (floor) pivots: R1 = 2P − L, S1 = 2P − H, R2 = P + (H − L), S2 = P − (H − L), R3 = H + 2(P − L), S3 = L − 2(H − P). */
export function classicPivots(basis: PivotBasis): PivotLevels {
  const { high: h, low: l } = basis;
  const p = pivotPoint(basis);
  const range = h.minus(l);
  return {
    p,
    r1: p.times(2).minus(l),
    s1: p.times(2).minus(h),
    r2: p.plus(range),
    s2: p.minus(range),
    r3: h.plus(p.minus(l).times(2)),
    s3: l.minus(h.minus(p).times(2)),
  };
}

const FIB = [Decimal.from('0.382'), Decimal.from('0.618'), Decimal.from('1.000')] as const;

/** Fibonacci pivots: R_n = P + f_n·(H − L), S_n = P − f_n·(H − L) with f = 0.382, 0.618, 1.000. */
export function fibonacciPivots(basis: PivotBasis): PivotLevels {
  const p = pivotPoint(basis);
  const range = basis.high.minus(basis.low);
  const [f1, f2, f3] = FIB;
  return {
    p,
    r1: p.plus(range.times(f1)),
    r2: p.plus(range.times(f2)),
    r3: p.plus(range.times(f3)),
    s1: p.minus(range.times(f1)),
    s2: p.minus(range.times(f2)),
    s3: p.minus(range.times(f3)),
  };
}
