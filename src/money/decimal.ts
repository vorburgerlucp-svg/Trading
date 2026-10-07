// Exact fixed-point decimal for quantities, prices, FX rates and factors.
// Value = units * 10^-scale. Backed by bigint, so there is no binary float rounding.
// Every operation that cannot be exact (division, reducing scale) takes an explicit RoundingMode.

export type RoundingMode =
  | 'half_even' // banker's rounding: ties to the even neighbour (default for neutral computations)
  | 'half_up' // ties away from zero
  | 'down' // toward zero (truncate)
  | 'up' // away from zero
  | 'floor' // toward -infinity
  | 'ceil'; // toward +infinity

export type DecimalInput = Decimal | string | number | bigint;

export class DecimalError extends Error {
  override readonly name = 'DecimalError';
}

const MAX_PARSE_SCALE = 36;
const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const POW10: bigint[] = [];

export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0) throw new DecimalError('pow10 requires a non-negative integer exponent, got ' + exponent);
  let cached = POW10[exponent];
  if (cached === undefined) {
    cached = 10n ** BigInt(exponent);
    POW10[exponent] = cached;
  }
  return cached;
}

/** Integer division numerator/denominator with an explicit rounding mode. */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new DecimalError('division by zero');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const quotient = numerator / denominator; // truncates toward zero
  const remainder = numerator % denominator; // carries the sign of the numerator
  if (remainder === 0n) return quotient;

  const negative = numerator < 0n;
  const awayFromZero = negative ? quotient - 1n : quotient + 1n;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;

  switch (mode) {
    case 'down':
      return quotient;
    case 'up':
      return awayFromZero;
    case 'floor':
      return negative ? awayFromZero : quotient;
    case 'ceil':
      return negative ? quotient : awayFromZero;
    case 'half_up':
      return twiceRemainder >= denominator ? awayFromZero : quotient;
    case 'half_even':
      if (twiceRemainder > denominator) return awayFromZero;
      if (twiceRemainder < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
  }
}

export class Decimal {
  static readonly ZERO: Decimal = new Decimal(0n, 0);
  static readonly ONE: Decimal = new Decimal(1n, 0);

  private constructor(
    readonly units: bigint,
    readonly scale: number,
  ) {
    Object.freeze(this);
  }

  /** Builds units * 10^-scale and normalizes trailing zeros (canonical form: "1.50" == "1.5"). */
  static of(units: bigint, scale = 0): Decimal {
    if (!Number.isInteger(scale)) throw new DecimalError('scale must be an integer, got ' + scale);
    if (scale < 0) return Decimal.of(units * pow10(-scale), 0);
    if (units === 0n) return Decimal.ZERO;
    while (scale > 0 && units % 10n === 0n) {
      units /= 10n;
      scale--;
    }
    return new Decimal(units, scale);
  }

  /**
   * Parses exact decimal input. Numbers are accepted via their shortest round-trip string form
   * (String(0.1) === "0.1"), so float artefacts like 0.1 + 0.2 surface as 17 digits instead of being hidden.
   */
  static from(value: DecimalInput): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === 'bigint') return Decimal.of(value, 0);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new DecimalError('number is not finite: ' + value);
      return Decimal.parse(String(value));
    }
    return Decimal.parse(value);
  }

  private static parse(text: string): Decimal {
    const match = DECIMAL_PATTERN.exec(text.trim());
    if (!match) throw new DecimalError('not a decimal number: "' + text + '"');
    const [, sign, integerDigits = '0', fractionDigits = '', exponentText] = match;
    const exponent = exponentText === undefined ? 0 : Number(exponentText);
    const scale = fractionDigits.length - exponent;
    if (scale > MAX_PARSE_SCALE) throw new DecimalError('too many decimal places (max ' + MAX_PARSE_SCALE + '): "' + text + '"');
    const magnitude = BigInt(integerDigits + fractionDigits);
    return Decimal.of(sign === '-' ? -magnitude : magnitude, scale);
  }

  private static align(a: Decimal, b: Decimal): [bigint, bigint, number] {
    if (a.scale === b.scale) return [a.units, b.units, a.scale];
    if (a.scale > b.scale) return [a.units, b.units * pow10(a.scale - b.scale), a.scale];
    return [a.units * pow10(b.scale - a.scale), b.units, b.scale];
  }

  plus(other: DecimalInput): Decimal {
    const [a, b, scale] = Decimal.align(this, Decimal.from(other));
    return Decimal.of(a + b, scale);
  }

  minus(other: DecimalInput): Decimal {
    const [a, b, scale] = Decimal.align(this, Decimal.from(other));
    return Decimal.of(a - b, scale);
  }

  times(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    return Decimal.of(this.units * o.units, this.scale + o.scale);
  }

  /** this / divisor, rounded to `scale` decimal places. */
  dividedBy(divisor: DecimalInput, scale: number, mode: RoundingMode): Decimal {
    const d = Decimal.from(divisor);
    if (d.units === 0n) throw new DecimalError('division by zero');
    // (A / 10^sa) / (B / 10^sb) * 10^s = A * 10^(sb + s) / (B * 10^sa)
    const numerator = this.units * pow10(d.scale + scale);
    const denominator = d.units * pow10(this.scale);
    return Decimal.of(divRound(numerator, denominator, mode), scale);
  }

  /** Reduces precision to at most `scale` decimal places. */
  round(scale: number, mode: RoundingMode): Decimal {
    if (this.scale <= scale) return this;
    return Decimal.of(divRound(this.units, pow10(this.scale - scale), mode), scale);
  }

  /** Integer value of this number expressed in units of 10^-scale, e.g. toUnits(2) of 12.345 → 1235n. */
  toUnits(scale: number, mode: RoundingMode): bigint {
    const rounded = this.round(scale, mode);
    return rounded.units * pow10(scale - rounded.scale);
  }

  negated(): Decimal {
    return Decimal.of(-this.units, this.scale);
  }

  abs(): Decimal {
    return this.units < 0n ? this.negated() : this;
  }

  cmp(other: DecimalInput): -1 | 0 | 1 {
    const [a, b] = Decimal.align(this, Decimal.from(other));
    return a < b ? -1 : a > b ? 1 : 0;
  }

  eq(other: DecimalInput): boolean {
    return this.cmp(other) === 0;
  }
  lt(other: DecimalInput): boolean {
    return this.cmp(other) < 0;
  }
  lte(other: DecimalInput): boolean {
    return this.cmp(other) <= 0;
  }
  gt(other: DecimalInput): boolean {
    return this.cmp(other) > 0;
  }
  gte(other: DecimalInput): boolean {
    return this.cmp(other) >= 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }
  isNegative(): boolean {
    return this.units < 0n;
  }
  isPositive(): boolean {
    return this.units > 0n;
  }
  isInteger(): boolean {
    return this.scale === 0;
  }

  /** Canonical string without trailing zeros, e.g. "-12.5". */
  toString(): string {
    return formatUnits(this.units, this.scale);
  }

  /** Fixed number of decimal places, rounding if necessary. */
  toFixed(scale: number, mode: RoundingMode = 'half_even'): string {
    return formatUnits(this.toUnits(scale, mode), scale);
  }

  toJSON(): string {
    return this.toString();
  }

  /** Lossy. Only for scores and display ratios, never for money. */
  toNumber(): number {
    return Number(this.toString());
  }
}

export function formatUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const integerPart = scale === 0 ? digits : digits.slice(0, -scale);
  const fractionPart = scale === 0 ? '' : '.' + digits.slice(-scale);
  return (negative ? '-' : '') + integerPart + fractionPart;
}
