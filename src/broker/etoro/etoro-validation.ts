// Schema validation of the eToro demo portfolio. Every response is untrusted external input: fail closed, no silent coercion, and
// unknown fields are ignored. The structure observed in a live demo response is clientPortfolio.<container>; the portfolio arrays
// are read from there, never from a top-level data field.
//
// What O20 can validate is an empty demo portfolio. Their field names are not yet verified against a live payload with entries,
// so a non-empty position or order array is refused, not guessed. Cash (clientPortfolio.credit) is checked for presence only: its
// value and structure are not yet observed, so no amount is derived from it.

import { BrokerError } from '../broker-errors.js';

/** Upper bound of entries in any portfolio array. A larger array is refused, never truncated. */
export const ETORO_MAX_ENTRIES = 500;

/** The containers observed in clientPortfolio. Each must be an array; all of them must be empty in O20. */
const PORTFOLIO_ARRAYS = [
  'positions',
  'mirrors',
  'orders',
  'stockOrders',
  'entryOrders',
  'exitOrders',
  'ordersForOpen',
  'ordersForClose',
  'ordersForCloseMultiple',
] as const;

export interface EtoroEmptyPortfolio {
  /** Always 0: a non-empty container is refused before this value is built. */
  readonly positionCount: 0;
  readonly orderCount: 0;
}

function invalid(detail: string): BrokerError {
  return new BrokerError('BROKER_RESPONSE_INVALID', detail);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(path + ' is not an object');
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(path + ' is not an array');
  if (value.length > ETORO_MAX_ENTRIES) throw invalid(path + ' has too many entries');
  return value;
}

/**
 * Validates a demo portfolio and returns the counts of an empty one. A missing container, a container of the wrong type, or a
 * container above the bound is BROKER_RESPONSE_INVALID. A non-empty container is refused as well, because its entries cannot be
 * mapped to a NEXUS snapshot without field names that are not yet verified.
 */
export function parseDemoPortfolio(body: unknown): EtoroEmptyPortfolio {
  const root = objectAt(body, 'portfolio');
  const portfolio = objectAt(root.clientPortfolio, 'clientPortfolio');
  if (portfolio.credit === undefined || portfolio.credit === null) throw invalid('clientPortfolio.credit is missing');
  for (const key of PORTFOLIO_ARRAYS) {
    const entries = arrayAt(portfolio[key], 'clientPortfolio.' + key);
    if (entries.length > 0) throw invalid('clientPortfolio.' + key + ' is not empty: its structure is not verified against a live payload');
  }
  return { positionCount: 0, orderCount: 0 };
}
