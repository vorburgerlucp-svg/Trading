// Payload validators (docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §14). Each implemented capability has one validator, and it fails closed: unknown fields,
// binary floats, NaN, Infinity, malformed timestamps and currencies are refused. A missing optional value stays null, never 0.

import { parseUtc, toUtcIso } from '../market-data/time.js';
import { FinancialGatewayError, type FinancialCapability } from './financial-types.js';

export type CanonicalData = Readonly<Record<string, unknown>>;

const DECIMAL = /^-?\d+(\.\d+)?$/;
const CURRENCY = /^[A-Z]{3}$/;
const PERIOD = /^\d{4}-(Q[1-4]|FY)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const FUNDAMENTAL_FIELDS = ['revenue', 'grossProfit', 'operatingIncome', 'ebit', 'netIncome', 'eps', 'cash', 'debt', 'equity', 'operatingCashFlow', 'capex', 'freeCashFlow'] as const;

function invalid(message: string): never {
  throw new FinancialGatewayError('SCHEMA_INVALID', message);
}

function objectOf(value: unknown, what: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(what + ' must be an object');
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) invalid(what + ' has an unknown field "' + key + '"');
  }
  return o;
}

function textOf(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL.test(value)) invalid(what + ' must be a printable string of at most ' + max + ' characters');
  return value;
}

function instantOf(value: unknown, what: string): string {
  if (typeof value !== 'string') invalid(what + ' must be a UTC instant');
  try {
    return toUtcIso(parseUtc(value));
  } catch {
    return invalid(what + ' must be a UTC instant');
  }
}

function decimalOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) invalid(what + ' must be an exact decimal string (no numbers, NaN or Infinity)');
  return value;
}

/** Missing or null means "not provided": it stays null and is never read as 0. */
function optionalDecimalOf(value: unknown, what: string): string | null {
  return value === undefined || value === null ? null : decimalOf(value, what);
}

function currencyOf(value: unknown): string {
  if (typeof value !== 'string' || !CURRENCY.test(value)) invalid('currency must be an ISO 4217 code');
  return value;
}

function fundamentals(candidate: unknown): CanonicalData {
  const o = objectOf(candidate, 'fundamentals payload', ['period', 'currency', 'publishedAt', 'effectiveAt', ...FUNDAMENTAL_FIELDS]);
  if (typeof o.period !== 'string' || !PERIOD.test(o.period)) invalid('period must be YYYY-Qn or YYYY-FY');
  if (o.publishedAt !== undefined) instantOf(o.publishedAt, 'publishedAt');
  if (o.effectiveAt !== undefined) instantOf(o.effectiveAt, 'effectiveAt');
  const data: Record<string, unknown> = { period: o.period, currency: currencyOf(o.currency) };
  for (const field of FUNDAMENTAL_FIELDS) data[field] = optionalDecimalOf(o[field], field);
  return Object.freeze(data);
}

function news(candidate: unknown): CanonicalData {
  const o = objectOf(candidate, 'news payload', ['articleId', 'publisher', 'publishedAt', 'url']);
  return Object.freeze({
    articleId: textOf(o.articleId, 'articleId', 128),
    publisher: textOf(o.publisher, 'publisher', 200),
    publishedAt: instantOf(o.publishedAt, 'publishedAt'),
    url: o.url === undefined || o.url === null ? null : textOf(o.url, 'url', 2048),
  });
}

function portfolio(candidate: unknown): CanonicalData {
  const o = objectOf(candidate, 'portfolio payload', ['asOf', 'currency', 'cash', 'positions']);
  if (!Array.isArray(o.positions)) invalid('positions must be an array');
  const positions = o.positions.map((entry: unknown, index: number) => {
    const p = objectOf(entry, 'position ' + index, ['providerSymbol', 'quantity', 'marketValue', 'currency']);
    return Object.freeze({
      providerSymbol: textOf(p.providerSymbol, 'providerSymbol', 64),
      quantity: decimalOf(p.quantity, 'quantity'),
      marketValue: optionalDecimalOf(p.marketValue, 'marketValue'),
      currency: currencyOf(p.currency),
    });
  });
  return Object.freeze({
    asOf: instantOf(o.asOf, 'asOf'),
    currency: currencyOf(o.currency),
    cash: decimalOf(o.cash, 'cash'),
    positions: Object.freeze(positions),
  });
}

const VALIDATORS: Partial<Record<FinancialCapability, (candidate: unknown) => CanonicalData>> = {
  fundamentals,
  news,
  portfolio_read: portfolio,
};

/** Validates a provider candidate and returns the normalized, frozen data for its capability. */
export function validatePayload(capability: FinancialCapability, candidate: unknown): CanonicalData {
  const validate = VALIDATORS[capability];
  if (!validate) throw new FinancialGatewayError('CAPABILITY_NOT_IMPLEMENTED', capability + ' has no validator in V1');
  return validate(candidate);
}
