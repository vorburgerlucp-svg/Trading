// Typed financial requests (docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §7). A request is built from a known shape only: there is no field for a tool name,
// URL, method or body, and an unknown field is refused. Models never build a request; the deterministic workflow does.

import { parseUtc, toUtcIso } from '../market-data/time.js';
import { FINANCIAL_CAPABILITIES, FINANCIAL_ENVIRONMENTS, FinancialGatewayError, IMPLEMENTED_CAPABILITIES, type FinancialEnvironment } from './financial-types.js';

interface RequestBase {
  readonly requestId: string;
  readonly connectorId: string;
  readonly asOf: string;
  readonly environment: FinancialEnvironment;
}

export interface FundamentalsRequest extends RequestBase {
  readonly capability: 'fundamentals';
  readonly instrumentId: string;
  readonly currency: string;
  readonly period: string;
}

export interface NewsRequest extends RequestBase {
  readonly capability: 'news';
  readonly instrumentId: string;
}

export interface PortfolioReadRequest extends RequestBase {
  readonly capability: 'portfolio_read';
}

export type FinancialRequest = FundamentalsRequest | NewsRequest | PortfolioReadRequest;

type ImplementedShape = 'fundamentals' | 'news' | 'portfolio_read';

const FIELDS: Readonly<Record<ImplementedShape, readonly string[]>> = {
  fundamentals: ['requestId', 'capability', 'connectorId', 'asOf', 'environment', 'instrumentId', 'currency', 'period'],
  news: ['requestId', 'capability', 'connectorId', 'asOf', 'environment', 'instrumentId'],
  portfolio_read: ['requestId', 'capability', 'connectorId', 'asOf', 'environment'],
};

const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CURRENCY = /^[A-Z]{3}$/;
const PERIOD = /^\d{4}-(Q[1-4]|FY)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function refuse(message: string): never {
  throw new FinancialGatewayError('REQUEST_INVALID', message);
}

function textOf(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL.test(value)) refuse(field + ' must be a printable string of at most ' + max + ' characters');
  return value;
}

function instantOf(value: unknown, field: string): string {
  if (typeof value !== 'string') refuse(field + ' must be a UTC instant');
  try {
    return toUtcIso(parseUtc(value));
  } catch {
    return refuse(field + ' must be a UTC instant');
  }
}

function connectorIdOf(value: unknown): string {
  if (typeof value !== 'string' || !CONNECTOR_ID.test(value)) refuse('connectorId must name a registered connector');
  return value;
}

function environmentOf(value: unknown): FinancialEnvironment {
  if (typeof value !== 'string' || !(FINANCIAL_ENVIRONMENTS as readonly string[]).includes(value)) refuse('environment must be shadow, research or production');
  return value as FinancialEnvironment;
}

/** Builds a request from a known shape only. Anything else is refused, and the result is frozen. */
export function parseFinancialRequest(raw: unknown): FinancialRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse('request must be an object');
  const r = raw as Record<string, unknown>;
  const capability = r.capability;
  if (typeof capability !== 'string' || !(FINANCIAL_CAPABILITIES as readonly string[]).includes(capability)) refuse('capability is not a financial capability');
  if (!(IMPLEMENTED_CAPABILITIES as readonly string[]).includes(capability)) throw new FinancialGatewayError('CAPABILITY_NOT_IMPLEMENTED', capability + ' has no validator in V1');
  const shape = capability as ImplementedShape;
  for (const key of Object.keys(r)) {
    if (!FIELDS[shape].includes(key)) refuse('field "' + key + '" is not part of a ' + shape + ' request');
  }
  const base = {
    requestId: textOf(r.requestId, 'requestId', 128),
    connectorId: connectorIdOf(r.connectorId),
    asOf: instantOf(r.asOf, 'asOf'),
    environment: environmentOf(r.environment),
  };
  if (shape === 'portfolio_read') return Object.freeze({ ...base, capability: 'portfolio_read' as const });
  const instrumentId = textOf(r.instrumentId, 'instrumentId', 128);
  if (shape === 'news') return Object.freeze({ ...base, capability: 'news' as const, instrumentId });
  if (typeof r.currency !== 'string' || !CURRENCY.test(r.currency)) refuse('currency must be an explicit ISO 4217 code');
  if (typeof r.period !== 'string' || !PERIOD.test(r.period)) refuse('period must be YYYY-Qn or YYYY-FY');
  return Object.freeze({ ...base, capability: 'fundamentals' as const, instrumentId, currency: r.currency, period: r.period });
}
