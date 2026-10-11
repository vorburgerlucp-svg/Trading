// Exact lines for pattern geometry: value(t) = a + b·t with t the bar index. Every operation is exact Decimal arithmetic. A slope is rounded
// half-even to a fixed scale, so the result is identical on every platform and independent of the order of the touches.

import { Decimal } from '../money/decimal.js';

/** Scale of a slope. Fixed: a change here is a change of the geometry version. */
export const SLOPE_SCALE = 12;
/** Scale of an intercept. Fixed for the same reason. */
export const INTERCEPT_SCALE = 18;

export interface Line {
  /** Value at bar index 0. */
  a: Decimal;
  /** Price change per bar. */
  b: Decimal;
}

export function valueAt(line: Line, t: number): Decimal {
  return line.a.plus(line.b.times(t));
}

export function horizontal(price: Decimal): Line {
  return { a: price, b: Decimal.ZERO };
}

/** The line through two points (x1, y1) and (x2, y2), with x1 ≠ x2. */
export function lineThrough(x1: number, y1: Decimal, x2: number, y2: Decimal): Line {
  if (x1 === x2) throw new Error('a line needs two different bar indices');
  const b = y2.minus(y1).dividedBy(x2 - x1, SLOPE_SCALE, 'half_even');
  return { a: y1.minus(b.times(x1)), b };
}

export interface Touch {
  x: number;
  y: Decimal;
}

/** Least squares through the touches (x = bar index). Exact sums; the same touches in any order give the same line. */
export function leastSquares(touches: readonly Touch[]): Line {
  const n = touches.length;
  if (n < 2) throw new Error('a least-squares line needs at least two touches');
  let sx = Decimal.ZERO;
  let sy = Decimal.ZERO;
  let sxy = Decimal.ZERO;
  let sxx = Decimal.ZERO;
  for (const { x, y } of touches) {
    sx = sx.plus(x);
    sy = sy.plus(y);
    sxy = sxy.plus(y.times(x));
    sxx = sxx.plus(x * x);
  }
  const denominator = sxx.times(n).minus(sx.times(sx));
  if (denominator.isZero()) throw new Error('touches share one bar index');
  const b = sxy.times(n).minus(sx.times(sy)).dividedBy(denominator, SLOPE_SCALE, 'half_even');
  const a = sy.minus(b.times(sx)).dividedBy(n, INTERCEPT_SCALE, 'half_even');
  return { a, b };
}

/** The largest absolute deviation of the touches from the line. */
export function maxResidual(line: Line, touches: readonly Touch[]): Decimal {
  let max = Decimal.ZERO;
  for (const { x, y } of touches) {
    const r = y.minus(valueAt(line, x)).abs();
    if (r.gt(max)) max = r;
  }
  return max;
}

/** The bar index where two lines meet: x* = (a_lower − a_upper) / (b_upper − b_lower). Null for parallel lines. */
export function apexOf(upper: Line, lower: Line): Decimal | null {
  const denom = upper.b.minus(lower.b);
  if (denom.isZero()) return null;
  return lower.a.minus(upper.a).dividedBy(denom, SLOPE_SCALE, 'half_even');
}

/** A line mirrored in price: value(t) → −value(t). */
export function negatedLine(line: Line): Line {
  return { a: line.a.negated(), b: line.b.negated() };
}
