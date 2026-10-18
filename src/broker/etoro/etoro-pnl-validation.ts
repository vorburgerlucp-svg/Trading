// Schema validation of the eToro demo PnL response (GET /api/v1/trading/info/demo/pnl, O21A.1). Untrusted external input: fail
// closed, no coercion, unknown fields ignored and never kept. It is used by the observation tool only; the sync adapter still reads
// /demo/portfolio. The response is DOCUMENTED, not yet live-observed.
//
// The official reference of this endpoint is internally inconsistent (checked 2026-10-17):
//   - its schema spells positionID / instrumentID / CID, its example positionId / instrumentId / cid;
//   - its schema nests PnL in a per-position object unrealizedPnL { pnL, closeRate, timestamp, ... }, its example has pnL /
//     closeRate / timestamp flat on the position;
//   - its order schemas (orders, ordersForOpen) spell orderId / instrumentId, unlike /demo/portfolio (orderID / instrumentID).
// The SCHEMA is taken as normative: only schema property names are read. A response in the example's spelling is refused with the
// field path, never read under a guessed alias. The observation report shows which spelling a live response uses.
//
// Read: positions (TradingRealAdminApi_Position + unrealizedPnL), orders, ordersForOpen. Must be empty: mirrors (copy trading),
// ordersForClose, ordersForCloseMultiple (closing flows are out of scope), and stockOrders / entryOrders / exitOrders when present.
// credit, bonusCredit, unrealizedPnL and accountCurrencyId are type-checked and NOT read by parseDemoPnl: cash stays not_read there.
// O22: parseDemoPnlValuationInput additionally returns credit, accountCurrencyId and the ordersForOpen external costs, for the
// demo account safety source only (the guide formulas). It is exactly as strict: anything parseDemoPnl refuses is refused.

import { Decimal } from '../../money/decimal.js';
import {
  arrayAt,
  booleanAt,
  codeAt,
  idAt,
  invalid,
  MAX_LEVERAGE,
  numberAt,
  objectAt,
  optionalBoolean,
  optionalRate,
  parsePosition,
  timestampAt,
  uniqueSorted,
  type EtoroDirection,
  type EtoroPosition,
} from './etoro-validation.js';

const MAX_MAGNITUDE = 1e12;

/** Containers that must be present (arrays) and are read. */
const READ_CONTAINERS = ['positions', 'orders', 'ordersForOpen'] as const;
/** Containers that must be present and empty. */
const EMPTY_ONLY_CONTAINERS = ['mirrors', 'ordersForClose', 'ordersForCloseMultiple'] as const;
/** Containers in the schema that may be absent; when present they must be empty arrays. */
const OPTIONAL_EMPTY_CONTAINERS = ['stockOrders', 'entryOrders', 'exitOrders'] as const;

/** The per-position unrealizedPnL object of the schema, as far as NEXUS keeps it. Values exactly as reported. */
export interface EtoroUnrealizedPnl {
  /** "Unrealized P&L in account currency". The account currency is not interpreted. */
  readonly pnlAccountCurrency: string | null;
  /** "Current close rate". */
  readonly closeRate: string | null;
  /** "Timestamp of the PnL calculation". */
  readonly timestamp: string | null;
}

export interface EtoroPnlPosition extends EtoroPosition {
  /** null when the schema's nullable unrealizedPnL object is absent or null. */
  readonly unrealizedPnl: EtoroUnrealizedPnl | null;
}

/** A pending order of clientPortfolio.orders in the PnL schema (orderId / instrumentId spelling). */
export interface EtoroPnlOrder {
  readonly orderId: number;
  readonly etoroInstrumentId: number;
  readonly direction: EtoroDirection;
  readonly amountUsd: string;
  readonly units: string;
  readonly rate: string | null;
  readonly leverage: string;
  readonly createdAt: string;
  readonly stopLossRate: string | null;
  readonly takeProfitRate: string | null;
  readonly stopLossDisabled: boolean | null;
  readonly takeProfitDisabled: boolean | null;
  readonly trailingStopLoss: boolean | null;
}

/** An order of clientPortfolio.ordersForOpen ("Active orders to open positions"). orderType and statusId are kept as raw codes. */
export interface EtoroPnlOrderForOpen {
  readonly orderId: number;
  readonly orderType: number;
  /** The documented statusId, uninterpreted: the reference gives no meaning for its values. */
  readonly statusId: number;
  readonly etoroInstrumentId: number;
  readonly direction: EtoroDirection;
  readonly amountUsd: string;
  /** amountInUnits, when stated. */
  readonly amountInUnits: string | null;
  readonly leverage: string;
  readonly createdAt: string;
}

export interface EtoroDemoPnl {
  readonly positionCount: number;
  readonly orderCount: number;
  readonly orderForOpenCount: number;
  readonly positions: readonly EtoroPnlPosition[];
  readonly orders: readonly EtoroPnlOrder[];
  readonly ordersForOpen: readonly EtoroPnlOrderForOpen[];
}

/** The schema types leverage as integer here (number in /demo/portfolio). */
function integerLeverageAt(value: unknown, path: string): string {
  const leverage = numberAt(value, path, { min: 1, max: MAX_LEVERAGE });
  if (!Number.isInteger(value)) throw invalid(path + ' is not an integer');
  return leverage;
}

function optionalNumberAt(value: unknown, path: string, min: number): string | null {
  if (value === undefined || value === null) return null;
  return numberAt(value, path, { min });
}

function optionalTimestampAt(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  return timestampAt(value, path);
}

function parseUnrealizedPnl(value: unknown, path: string): EtoroUnrealizedPnl | null {
  if (value === undefined || value === null) return null;
  const u = objectAt(value, path);
  return {
    pnlAccountCurrency: optionalNumberAt(u.pnL, path + '.pnL', -MAX_MAGNITUDE),
    closeRate: optionalRate(u.closeRate, path + '.closeRate'),
    timestamp: optionalTimestampAt(u.timestamp, path + '.timestamp'),
  };
}

function parsePnlPosition(value: unknown, path: string): EtoroPnlPosition {
  const position = parsePosition(value, path);
  const p = value as Record<string, unknown>;
  return { ...position, leverage: integerLeverageAt(p.leverage, path + '.leverage'), unrealizedPnl: parseUnrealizedPnl(p.unrealizedPnL, path + '.unrealizedPnL') };
}

function parsePnlOrder(value: unknown, path: string): EtoroPnlOrder {
  const o = objectAt(value, path);
  return {
    orderId: idAt(o.orderId, path + '.orderId'),
    etoroInstrumentId: idAt(o.instrumentId, path + '.instrumentId'),
    direction: booleanAt(o.isBuy, path + '.isBuy') ? 'buy' : 'sell',
    amountUsd: numberAt(o.amount, path + '.amount', { min: 0 }),
    units: numberAt(o.units, path + '.units', { min: 0 }),
    rate: optionalRate(o.rate, path + '.rate'),
    leverage: integerLeverageAt(o.leverage, path + '.leverage'),
    createdAt: timestampAt(o.openDateTime, path + '.openDateTime'),
    stopLossRate: optionalRate(o.stopLossRate, path + '.stopLossRate'),
    takeProfitRate: optionalRate(o.takeProfitRate, path + '.takeProfitRate'),
    stopLossDisabled: optionalBoolean(o.isNoStopLoss, path + '.isNoStopLoss'),
    takeProfitDisabled: optionalBoolean(o.isNoTakeProfit, path + '.isNoTakeProfit'),
    trailingStopLoss: optionalBoolean(o.isTslEnabled, path + '.isTslEnabled'),
  };
}

function parsePnlOrderForOpen(value: unknown, path: string): EtoroPnlOrderForOpen {
  const o = objectAt(value, path);
  // Copy-trading orders are out of scope (the available-cash guide filters ordersForOpen by mirrorID = 0).
  if (o.mirrorId !== undefined && o.mirrorId !== 0) throw invalid(path + '.mirrorId is not 0: copy-trading orders are not supported');
  return {
    orderId: idAt(o.orderId, path + '.orderId'),
    orderType: codeAt(o.orderType, path + '.orderType'),
    statusId: codeAt(o.statusId, path + '.statusId'),
    etoroInstrumentId: idAt(o.instrumentId, path + '.instrumentId'),
    direction: booleanAt(o.isBuy, path + '.isBuy') ? 'buy' : 'sell',
    amountUsd: numberAt(o.amount, path + '.amount', { min: 0 }),
    amountInUnits: optionalNumberAt(o.amountInUnits, path + '.amountInUnits', 0),
    leverage: integerLeverageAt(o.leverage, path + '.leverage'),
    createdAt: timestampAt(o.openDateTime, path + '.openDateTime'),
  };
}

function optionalFiniteNumber(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  numberAt(value, path, { min: -MAX_MAGNITUDE });
}

/**
 * O22: the account values the official guides compute from this response ("Calculate Available Cash", "Calculate Total Invested",
 * "Calculate Profit/Loss", "Calculate Equity", checked 2026-10-18), read only from schema fields of a response parseDemoPnl
 * accepted. A value the guides need and the response does not state is null: it is never read as zero.
 */
export interface EtoroDemoPnlAccount {
  /** clientPortfolio.credit. */
  readonly creditUsd: string;
  /** clientPortfolio.accountCurrencyId ("1 = USD"), null when absent. */
  readonly accountCurrencyId: number | null;
  /** Σ ordersForOpen[i].totalExternalCosts (mirrorID = 0 only; mirrors are refused). null when an order does not state it. */
  readonly ordersForOpenExternalCostsUsd: string | null;
}

export interface EtoroDemoPnlValuationInput extends EtoroDemoPnl {
  readonly account: EtoroDemoPnlAccount;
}

/** parseDemoPnl plus the account values. The same strictness: anything parseDemoPnl refuses is refused here. */
export function parseDemoPnlValuationInput(body: unknown): EtoroDemoPnlValuationInput {
  const parsed = parseDemoPnl(body);
  const portfolio = objectAt(objectAt(body, 'pnl').clientPortfolio, 'clientPortfolio');
  const creditUsd = numberAt(portfolio.credit, 'clientPortfolio.credit', { min: -MAX_MAGNITUDE });
  const accountCurrencyId = portfolio.accountCurrencyId === undefined || portfolio.accountCurrencyId === null ? null : codeAt(portfolio.accountCurrencyId, 'clientPortfolio.accountCurrencyId');
  const forOpen = arrayAt(portfolio.ordersForOpen, 'clientPortfolio.ordersForOpen');
  let costs: Decimal | null = Decimal.from(0);
  for (let i = 0; i < forOpen.length; i++) {
    const o = objectAt(forOpen[i], 'clientPortfolio.ordersForOpen[' + i + ']');
    if (o.totalExternalCosts === undefined || o.totalExternalCosts === null) {
      costs = null;
      continue;
    }
    const cost = numberAt(o.totalExternalCosts, 'clientPortfolio.ordersForOpen[' + i + '].totalExternalCosts', { min: 0 });
    if (costs !== null) costs = costs.plus(cost);
  }
  return Object.freeze({
    ...parsed,
    account: Object.freeze({ creditUsd, accountCurrencyId, ordersForOpenExternalCostsUsd: costs === null ? null : costs.toString() }),
  });
}

/**
 * Validates a demo PnL response. Malformed structure, a malformed entry of a read container, or a non-empty container that is not
 * read is BROKER_RESPONSE_INVALID. An empty account is valid. Cash fields are checked and never returned.
 */
export function parseDemoPnl(body: unknown): EtoroDemoPnl {
  const root = objectAt(body, 'pnl');
  const portfolio = objectAt(root.clientPortfolio, 'clientPortfolio');
  // Cash-related fields: checked, not read.
  if (portfolio.credit === undefined || portfolio.credit === null) throw invalid('clientPortfolio.credit is missing');
  numberAt(portfolio.credit, 'clientPortfolio.credit', { min: -MAX_MAGNITUDE });
  optionalFiniteNumber(portfolio.bonusCredit, 'clientPortfolio.bonusCredit');
  optionalFiniteNumber(portfolio.unrealizedPnL, 'clientPortfolio.unrealizedPnL');
  if (portfolio.accountCurrencyId !== undefined && portfolio.accountCurrencyId !== null) codeAt(portfolio.accountCurrencyId, 'clientPortfolio.accountCurrencyId');

  for (const key of EMPTY_ONLY_CONTAINERS) {
    if (arrayAt(portfolio[key], 'clientPortfolio.' + key).length > 0) throw invalid('clientPortfolio.' + key + ' is not empty: it is not read in this build');
  }
  for (const key of OPTIONAL_EMPTY_CONTAINERS) {
    if (portfolio[key] === undefined) continue;
    if (arrayAt(portfolio[key], 'clientPortfolio.' + key).length > 0) throw invalid('clientPortfolio.' + key + ' is not empty: it is not read in this build');
  }
  const [positionsRaw, ordersRaw, forOpenRaw] = READ_CONTAINERS.map((key) => arrayAt(portfolio[key], 'clientPortfolio.' + key));
  const positions = uniqueSorted(positionsRaw!.map((e, i) => parsePnlPosition(e, 'clientPortfolio.positions[' + i + ']')), (p) => p.positionId, 'clientPortfolio.positions');
  const orders = uniqueSorted(ordersRaw!.map((e, i) => parsePnlOrder(e, 'clientPortfolio.orders[' + i + ']')), (o) => o.orderId, 'clientPortfolio.orders');
  const ordersForOpen = uniqueSorted(forOpenRaw!.map((e, i) => parsePnlOrderForOpen(e, 'clientPortfolio.ordersForOpen[' + i + ']')), (o) => o.orderId, 'clientPortfolio.ordersForOpen');
  return Object.freeze({
    positionCount: positions.length,
    orderCount: orders.length,
    orderForOpenCount: ordersForOpen.length,
    positions: Object.freeze(positions),
    orders: Object.freeze(orders),
    ordersForOpen: Object.freeze(ordersForOpen),
  });
}
