// CHF money as integer Rappen (1 CHF = 100 Rappen) in a branded bigint.
// The brand prevents a raw bigint such as `20n` (CHF? Rappen?) from silently becoming money:
// amounts are created only through chf(), chfRounded() or rappen().
//
// Rounding policy: wherever a direction is "safer", round conservatively
// (costs/downside/reserves up, budgets/expected gains down); otherwise use half_even.

import { Decimal, divRound, formatUnits, type DecimalInput, type RoundingMode } from './decimal.js';

declare const RAPPEN_BRAND: unique symbol;
export type Rappen = bigint & { readonly [RAPPEN_BRAND]: true };

export const CHF_SCALE = 2;
export const BASIS_POINTS = 10_000n;
export const ZERO_CHF = rappen(0n);

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/** Wraps an integer number of Rappen. */
export function rappen(units: bigint): Rappen {
  return units as Rappen;
}

/** Exact CHF amount. Throws if the value has more than 2 decimal places (e.g. 0.1 + 0.2). */
export function chf(value: DecimalInput): Rappen {
  const amount = Decimal.from(value);
  if (amount.scale > CHF_SCALE) {
    throw new MoneyError('CHF amount "' + amount.toString() + '" has more than 2 decimal places; use chfRounded() with an explicit rounding mode');
  }
  return rappen(amount.toUnits(CHF_SCALE, 'half_even'));
}

/** CHF amount rounded to whole Rappen with an explicit rounding mode (for computed values). */
export function chfRounded(value: DecimalInput, mode: RoundingMode): Rappen {
  return rappen(Decimal.from(value).toUnits(CHF_SCALE, mode));
}

export function chfToDecimal(amount: Rappen): Decimal {
  return Decimal.of(amount, CHF_SCALE);
}

export function addChf(...amounts: Rappen[]): Rappen {
  return sumChf(amounts);
}

export function sumChf(amounts: Iterable<Rappen>): Rappen {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return rappen(total);
}

export function subChf(a: Rappen, b: Rappen): Rappen {
  return rappen(a - b);
}

export function negChf(a: Rappen): Rappen {
  return rappen(-a);
}

export function absChf(a: Rappen): Rappen {
  return a < 0n ? negChf(a) : a;
}

export function minChf(first: Rappen, ...rest: Rappen[]): Rappen {
  return rest.reduce((min, a) => (a < min ? a : min), first);
}

export function maxChf(first: Rappen, ...rest: Rappen[]): Rappen {
  return rest.reduce((max, a) => (a > max ? a : max), first);
}

/** max(0, a) */
export function nonNegativeChf(a: Rappen): Rappen {
  return a < 0n ? ZERO_CHF : a;
}

/** amount * factor, rounded to whole Rappen. */
export function mulChf(amount: Rappen, factor: DecimalInput, mode: RoundingMode): Rappen {
  return chfRounded(chfToDecimal(amount).times(factor), mode);
}

/** amount * basisPoints / 10'000 (100 bp = 1 %). */
export function applyBp(amount: Rappen, basisPoints: number, mode: RoundingMode): Rappen {
  return rappen(divRound(amount * toBigIntBp(basisPoints), BASIS_POINTS, mode));
}

/** amount * part / whole, e.g. pro-rata cost basis when selling part of a position. */
export function prorateChf(amount: Rappen, part: DecimalInput, whole: DecimalInput, mode: RoundingMode): Rappen {
  const w = Decimal.from(whole);
  if (w.isZero()) throw new MoneyError('cannot prorate against a zero whole');
  return rappen(chfToDecimal(amount).times(part).dividedBy(w, CHF_SCALE, mode).toUnits(CHF_SCALE, 'half_even'));
}

/** numerator / denominator in basis points (e.g. ROI). Ratios are not money and may be returned as number. */
export function ratioBp(numerator: Rappen, denominator: Rappen, mode: RoundingMode = 'half_even'): number {
  if (denominator === 0n) throw new MoneyError('ratio with zero denominator');
  return Number(divRound(numerator * BASIS_POINTS, denominator, mode));
}

/** Lossy ratio for scoring only. */
export function ratioNumber(numerator: Rappen, denominator: Rappen): number {
  if (denominator === 0n) throw new MoneyError('ratio with zero denominator');
  return chfToDecimal(numerator).dividedBy(chfToDecimal(denominator), 12, 'half_even').toNumber();
}

/**
 * Splits a non-negative total into parts proportional to the weights (largest-remainder method).
 * The parts always add up to the total exactly; leftover Rappen go to the largest remainders, ties by index.
 */
export function splitChf(total: Rappen, weights: readonly bigint[]): Rappen[] {
  if (total < 0n) throw new MoneyError('cannot split a negative amount');
  if (weights.length === 0) throw new MoneyError('cannot split without weights');
  if (weights.some((w) => w < 0n)) throw new MoneyError('weights must be non-negative');
  const weightSum = weights.reduce((s, w) => s + w, 0n);
  if (weightSum === 0n) throw new MoneyError('weights must not all be zero');

  const parts = weights.map((w) => (total * w) / weightSum);
  let leftover = total - parts.reduce((s, p) => s + p, 0n);
  const byRemainder = weights
    .map((w, index) => ({ index, remainder: (total * w) % weightSum }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const { index } of byRemainder) {
    if (leftover === 0n) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    leftover--;
  }
  return parts.map(rappen);
}

/** Machine format, e.g. "1234.50" / "-0.05". */
export function formatChf(amount: Rappen): string {
  return formatUnits(amount, CHF_SCALE);
}

/** Swiss display format, e.g. "CHF 1'234.50". */
export function displayChf(amount: Rappen): string {
  const [integerPart = '0', fractionPart = '00'] = formatChf(absChf(amount)).split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return 'CHF ' + (amount < 0n ? '-' : '') + grouped + '.' + fractionPart;
}

function toBigIntBp(basisPoints: number): bigint {
  if (!Number.isSafeInteger(basisPoints)) throw new MoneyError('basis points must be an integer, got ' + basisPoints);
  return BigInt(basisPoints);
}
