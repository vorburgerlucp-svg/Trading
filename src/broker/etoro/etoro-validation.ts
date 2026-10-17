// Schema validation of the eToro demo portfolio (GET /api/v1/trading/info/demo/portfolio). Every response is untrusted external
// input: fail closed, no silent coercion, unknown fields are ignored. The portfolio is read from clientPortfolio.<container>, never
// from a top-level field.
//
// O20 verified the empty live shape. O21A reads the two containers whose element schema the official reference documents:
//   positions  (TradingDemoApi_Position)  and  orders  ("List of pending orders").
// The reference has no `required` list and no integer format (int32/int64) for the ids. Which fields NEXUS requires, and the bounds
// below, are NEXUS policy, not eToro documentation: an id must be a positive safe integer, so an id that JSON.parse cannot represent
// exactly is refused.
// Every other container is refused when it is not empty: the reference gives stockOrders, entryOrders and exitOrders as obsolete,
// and ordersForOpen, ordersForClose and ordersForCloseMultiple only as `items: { type: object }` with no properties, so nothing about
// their entries is known; mirrors (copy trading) are out of scope. The documented position and order shapes are NOT yet observed in a
// live response: a field NEXUS needs that is missing or of another type is BROKER_RESPONSE_INVALID, never guessed.
//
// Cash (clientPortfolio.credit) is checked for presence only and not read: the reference calls it "Available trading balance in USD",
// but it is not verified against a live account, so no amount is derived from it.

import { BrokerError } from '../broker-errors.js';
import { Decimal } from '../../money/decimal.js';

/** Upper bound of entries in any portfolio array. A larger array is refused, never truncated. */
export const ETORO_MAX_ENTRIES = 500;
/** Upper bound of every amount, rate and unit count the parser accepts. A larger value is refused. */
const MAX_MAGNITUDE = 1e12;
const MAX_LEVERAGE = 1000;

/** The containers that are read when present with entries (documented element schema). */
const READ_CONTAINERS = ['positions', 'orders'] as const;
/** The containers that must be empty: obsolete, undocumented element schema, or out of scope (mirrors). */
const EMPTY_ONLY_CONTAINERS = ['mirrors', 'stockOrders', 'entryOrders', 'exitOrders', 'ordersForOpen', 'ordersForClose', 'ordersForCloseMultiple'] as const;

export type EtoroDirection = 'buy' | 'sell';

/**
 * An open demo position, as NEXUS keeps it: the broker identity and the fields NEXUS needs. Not kept: the customer id (CID), fees,
 * taxes, P&L fields and every obsolete or undocumented field. Decimal values are canonical decimal strings.
 */
export interface EtoroPosition {
  readonly positionId: number;
  /** The eToro instrument identity. A NEXUS instrument is found only through the human-governed etoro mapping. */
  readonly etoroInstrumentId: number;
  readonly direction: EtoroDirection;
  readonly units: string;
  /** Entry price, in the instrument's currency (reference). That currency is not stated in the payload. */
  readonly openRate: string;
  readonly leverage: string;
  /** "USD amount allocated to the position including initial investment and margin" (reference). */
  readonly amountUsd: string;
  readonly openedAt: string;
  /** The stop-loss and take-profit trigger rates exactly as reported (null when absent). No meaning is given to a value of 0. */
  readonly stopLossRate: string | null;
  readonly takeProfitRate: string | null;
  /** The reference flags isNoStopLoss / isNoTakeProfit ("true = disabled"), null when absent. */
  readonly stopLossDisabled: boolean | null;
  readonly takeProfitDisabled: boolean | null;
  /** isTslEnabled: a trailing stop loss moves stopLossRate. Null when absent. */
  readonly trailingStopLoss: boolean | null;
  /** The order the position was opened by. The reference: orderID "need[s] to match together with orderType", so both or neither. */
  readonly openOrder: { readonly orderId: number; readonly orderType: number } | null;
}

/** A pending order of clientPortfolio.orders, as NEXUS keeps it. Not kept: the customer id, executionType and obsolete fields. */
export interface EtoroPendingOrder {
  readonly orderId: number;
  readonly etoroInstrumentId: number;
  readonly direction: EtoroDirection;
  readonly amountUsd: string;
  readonly units: string;
  /** "Asset rate at which to send market order to the market" (reference), when stated. */
  readonly rate: string | null;
  readonly leverage: string;
  readonly createdAt: string;
  /** Exactly as reported (null when absent). No meaning is given to a value of 0. */
  readonly stopLossRate: string | null;
  readonly takeProfitRate: string | null;
  /** isTslEnabled, null when absent. */
  readonly trailingStopLoss: boolean | null;
}

export interface EtoroDemoPortfolio {
  readonly positionCount: number;
  readonly orderCount: number;
  /** Sorted by positionId. */
  readonly positions: readonly EtoroPosition[];
  /** Sorted by orderId. */
  readonly orders: readonly EtoroPendingOrder[];
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

/** A positive integer id that round-trips exactly. The reference states `integer` with no format; NEXUS accepts safe integers only. */
function idAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw invalid(path + ' is not a positive integer id');
  return value;
}

function codeAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(path + ' is not a non-negative integer');
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw invalid(path + ' is not a boolean');
  return value;
}

/** A finite JSON number within the bound, as a canonical decimal string. JSON has no NaN; an overflowing literal parses to Infinity. */
function numberAt(value: unknown, path: string, options: { min: number; exclusiveMin?: boolean; max?: number }): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(path + ' is not a finite number');
  const max = options.max ?? MAX_MAGNITUDE;
  if (value > max || (options.exclusiveMin ? value <= options.min : value < options.min)) throw invalid(path + ' is out of range');
  try {
    return Decimal.from(value).toString();
  } catch {
    throw invalid(path + ' is not a representable decimal');
  }
}

function optionalRate(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  return numberAt(value, path, { min: 0 });
}

function optionalBoolean(value: unknown, path: string): boolean | null {
  if (value === undefined || value === null) return null;
  return booleanAt(value, path);
}

function timestampAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 40) throw invalid(path + ' is not a timestamp');
  // ISO 8601 with a time and an explicit UTC offset or Z; normalized to canonical UTC.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalid(path + ' is not an ISO 8601 timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw invalid(path + ' is not a valid timestamp');
  return new Date(ms).toISOString();
}

/** orderID and orderType as one pair: absent or 0 orderID means no stated order; an orderID without a valid orderType is refused. */
function openOrderOf(p: Record<string, unknown>, path: string): { orderId: number; orderType: number } | null {
  if (p.orderID === undefined || p.orderID === null || p.orderID === 0) return null;
  return { orderId: idAt(p.orderID, path + '.orderID'), orderType: codeAt(p.orderType, path + '.orderType') };
}

function parsePosition(value: unknown, path: string): EtoroPosition {
  const p = objectAt(value, path);
  // Copy-trading positions are out of scope: a position must not belong to a mirror (the reference: 0 otherwise).
  if (p.mirrorID !== undefined && p.mirrorID !== 0) throw invalid(path + '.mirrorID is not 0: copy-trading positions are not supported');
  if (p.parentPositionID !== undefined && p.parentPositionID !== 0) throw invalid(path + '.parentPositionID is not 0: copy-trading positions are not supported');
  return {
    positionId: idAt(p.positionID, path + '.positionID'),
    etoroInstrumentId: idAt(p.instrumentID, path + '.instrumentID'),
    direction: booleanAt(p.isBuy, path + '.isBuy') ? 'buy' : 'sell',
    units: numberAt(p.units, path + '.units', { min: 0, exclusiveMin: true }),
    openRate: numberAt(p.openRate, path + '.openRate', { min: 0, exclusiveMin: true }),
    leverage: numberAt(p.leverage, path + '.leverage', { min: 1, max: MAX_LEVERAGE }),
    amountUsd: numberAt(p.amount, path + '.amount', { min: 0 }),
    openedAt: timestampAt(p.openDateTime, path + '.openDateTime'),
    stopLossRate: optionalRate(p.stopLossRate, path + '.stopLossRate'),
    takeProfitRate: optionalRate(p.takeProfitRate, path + '.takeProfitRate'),
    stopLossDisabled: optionalBoolean(p.isNoStopLoss, path + '.isNoStopLoss'),
    takeProfitDisabled: optionalBoolean(p.isNoTakeProfit, path + '.isNoTakeProfit'),
    trailingStopLoss: optionalBoolean(p.isTslEnabled, path + '.isTslEnabled'),
    openOrder: openOrderOf(p, path),
  };
}

function parseOrder(value: unknown, path: string): EtoroPendingOrder {
  const o = objectAt(value, path);
  return {
    orderId: idAt(o.orderID, path + '.orderID'),
    etoroInstrumentId: idAt(o.instrumentID, path + '.instrumentID'),
    direction: booleanAt(o.isBuy, path + '.isBuy') ? 'buy' : 'sell',
    amountUsd: numberAt(o.amount, path + '.amount', { min: 0 }),
    units: numberAt(o.units, path + '.units', { min: 0 }),
    rate: optionalRate(o.rate, path + '.rate'),
    leverage: numberAt(o.leverage, path + '.leverage', { min: 1, max: MAX_LEVERAGE }),
    createdAt: timestampAt(o.openDateTime, path + '.openDateTime'),
    stopLossRate: optionalRate(o.stopLossRate, path + '.stopLossRate'),
    takeProfitRate: optionalRate(o.takeProfitRate, path + '.takeProfitRate'),
    trailingStopLoss: optionalBoolean(o.isTslEnabled, path + '.isTslEnabled'),
  };
}

function uniqueSorted<T>(entries: T[], idOf: (entry: T) => number, path: string): T[] {
  const sorted = [...entries].sort((a, b) => idOf(a) - idOf(b));
  for (let i = 1; i < sorted.length; i++) if (idOf(sorted[i]!) === idOf(sorted[i - 1]!)) throw invalid(path + ' has a duplicate id');
  return sorted;
}

/**
 * Validates a demo portfolio. A missing container, a container of the wrong type or above the bound, a non-empty container whose
 * entries are not documented, and an entry of positions or orders that does not match the documented fields NEXUS needs are all
 * BROKER_RESPONSE_INVALID. An empty portfolio stays valid.
 */
export function parseDemoPortfolio(body: unknown): EtoroDemoPortfolio {
  const root = objectAt(body, 'portfolio');
  const portfolio = objectAt(root.clientPortfolio, 'clientPortfolio');
  if (portfolio.credit === undefined || portfolio.credit === null) throw invalid('clientPortfolio.credit is missing');
  for (const key of EMPTY_ONLY_CONTAINERS) {
    const entries = arrayAt(portfolio[key], 'clientPortfolio.' + key);
    if (entries.length > 0) throw invalid('clientPortfolio.' + key + ' is not empty: its entries are not documented or not supported, so nothing is read');
  }
  const [positionsRaw, ordersRaw] = READ_CONTAINERS.map((key) => arrayAt(portfolio[key], 'clientPortfolio.' + key));
  const positions = uniqueSorted(positionsRaw!.map((entry, i) => parsePosition(entry, 'clientPortfolio.positions[' + i + ']')), (p) => p.positionId, 'clientPortfolio.positions');
  const orders = uniqueSorted(ordersRaw!.map((entry, i) => parseOrder(entry, 'clientPortfolio.orders[' + i + ']')), (o) => o.orderId, 'clientPortfolio.orders');
  return Object.freeze({ positionCount: positions.length, orderCount: orders.length, positions: Object.freeze(positions), orders: Object.freeze(orders) });
}
