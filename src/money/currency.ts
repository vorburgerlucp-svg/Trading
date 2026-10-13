// Multi-currency money for broker snapshots and future multi-currency ledger accounts.
// The capital ledger stays CHF-only (Rappen) for now; this module is the planned bridge.
// Rules: amounts are integer minor units (bigint), never floats; currencies never mix silently;
// every conversion needs an explicit FX rate with source and timestamp, and stale rates are refused.

import { Decimal, pow10, type DecimalInput, type RoundingMode } from './decimal.js';
import { rappen, type Rappen } from './money.js';

export type CurrencyCode = string & { readonly __currency: true };

/** ISO 4217 minor-unit exponents for currencies NEXUS expects. Unknown codes are rejected, not guessed. */
const MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({ CHF: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0, CAD: 2, AUD: 2, SEK: 2, NOK: 2, DKK: 2 });

export class CurrencyError extends Error {
  override readonly name = 'CurrencyError';
}

export function currency(code: string): CurrencyCode {
  if (!/^[A-Z]{3}$/.test(code) || MINOR_UNITS[code] === undefined) throw new CurrencyError('unsupported currency "' + code + '"');
  return code as CurrencyCode;
}

export function minorUnits(code: CurrencyCode): number {
  return MINOR_UNITS[code] as number;
}

export interface Money {
  readonly currency: CurrencyCode;
  readonly minor: bigint;
}

/** Exact amount; throws if the value has more decimals than the currency allows. */
export function money(code: string, amount: DecimalInput): Money {
  const c = currency(code);
  const value = Decimal.from(amount);
  if (value.scale > minorUnits(c)) throw new CurrencyError(code + ' amount "' + value.toString() + '" has too many decimal places');
  return Object.freeze({ currency: c, minor: value.toUnits(minorUnits(c), 'half_even') });
}

export function moneyToDecimal(m: Money): Decimal {
  return Decimal.of(m.minor, minorUnits(m.currency));
}

export function formatMoney(m: Money): string {
  return m.currency + ' ' + moneyToDecimal(m).toFixed(minorUnits(m.currency));
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyError('cannot add ' + a.currency + ' and ' + b.currency + ' without an explicit FX conversion');
  return Object.freeze({ currency: a.currency, minor: a.minor + b.minor });
}

export function fromRappen(amount: Rappen): Money {
  return Object.freeze({ currency: currency('CHF'), minor: amount as bigint });
}

export function toRappen(m: Money): Rappen {
  if (m.currency !== 'CHF') throw new CurrencyError('only CHF converts to Rappen directly; convert ' + m.currency + ' with an FX rate first');
  return rappen(m.minor);
}

/** 1 unit of `base` = `rate` units of `quote`. */
export interface FxRate {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: Decimal;
  source: string;
  observedAt: string;
  retrievedAt: string;
}

export interface FxConversion {
  result: Money;
  from: Money;
  rate: FxRate;
  rateAgeMs: number;
  rounding: RoundingMode;
}

/** Converts with an explicit, fresh rate. No implicit rates, no inverse guessing, no stale data. */
export function convertMoney(
  amount: Money,
  fx: FxRate,
  options: { to: CurrencyCode; asOf: string; maxAgeMs: number; rounding?: RoundingMode },
): FxConversion {
  if (fx.base !== amount.currency || fx.quote !== options.to) {
    throw new CurrencyError('FX rate ' + fx.base + '/' + fx.quote + ' does not convert ' + amount.currency + ' to ' + options.to);
  }
  if (!fx.rate.isPositive()) throw new CurrencyError('FX rate must be positive');
  if (fx.source.trim() === '') throw new CurrencyError('FX rate needs a source');
  const ageMs = Date.parse(options.asOf) - Date.parse(fx.observedAt);
  if (Number.isNaN(ageMs)) throw new CurrencyError('invalid FX or asOf timestamp');
  if (ageMs < 0) throw new CurrencyError('FX rate observed after asOf (look-ahead)');
  if (ageMs > options.maxAgeMs) throw new CurrencyError('FX rate is stale: ' + ageMs + ' ms old (max ' + options.maxAgeMs + ')');

  const rounding = options.rounding ?? 'half_even';
  const fromScale = minorUnits(amount.currency);
  const toScale = minorUnits(options.to);
  // minor_to = minor_from * rate * 10^(toScale - fromScale), rounded once.
  const exact = Decimal.of(amount.minor, 0).times(fx.rate);
  const shift = toScale - fromScale;
  const scaled = shift >= 0 ? exact.times(pow10(shift)) : exact.dividedBy(pow10(-shift), 0, rounding);
  const minor = scaled.toUnits(0, rounding);
  return { result: Object.freeze({ currency: options.to, minor }), from: amount, rate: fx, rateAgeMs: ageMs, rounding };
}
