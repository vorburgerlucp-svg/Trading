// Schema validation of IBKR responses. Every response is untrusted external input: each field is checked for presence, type,
// size and shape before it is used, unknown fields are ignored, and nothing is coerced silently. A field that does not
// match the official reference is an error (BROKER_RESPONSE_INVALID), never a guess. Error details name the field only.

import { Decimal } from '../../money/decimal.js';
import { IbkrError } from './ibkr-errors.js';
import { IBKR_MAX_ACCOUNTS, IBKR_MAX_ORDERS } from './ibkr-limits.js';
import { IBKR_PORTFOLIO_PAGE_SIZE } from './ibkr-readonly.js';

const ACCOUNT_ID = /^[A-Za-z0-9]{1,32}$/;
const CURRENCY = /^[A-Z]{3}$/;
const CONID = /^[0-9]{1,15}$/;
const DECIMAL_TEXT = /^-?[0-9]{1,20}(\.[0-9]{1,20})?$/;
const STATUS_TEXT = /^[A-Za-z ]{1,64}$/;

function invalid(detail: string): IbkrError {
  return new IbkrError('BROKER_RESPONSE_INVALID', detail);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(path + ' is not an object');
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw invalid(path + ' is not an array');
  if (value.length > max) throw invalid(path + ' has too many entries');
  return value;
}

function stringField(obj: Record<string, unknown>, key: string, path: string, pattern: RegExp): string {
  const value = obj[key];
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid(path + '.' + key);
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string, path: string, max: number): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw invalid(path + '.' + key);
  return value;
}

/** A conid or an order id: a JSON integer or its digits as a string (the official samples use both). */
function identifier(value: unknown, path: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && CONID.test(value)) return value;
  throw invalid(path);
}

/** A quantity or amount: a finite number or its decimal text. Exponent notation is refused. */
function decimal(value: unknown, path: string): Decimal {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(path);
    const text = String(value);
    if (!DECIMAL_TEXT.test(text)) throw invalid(path);
    return Decimal.from(text);
  }
  if (typeof value === 'string' && DECIMAL_TEXT.test(value)) return Decimal.from(value);
  throw invalid(path);
}

function optionalDecimal(value: unknown, path: string): Decimal | null {
  return value === undefined || value === null ? null : decimal(value, path);
}

export interface TickleResult {
  /** Always true. A session that is not valid is refused with an error, never returned as a quiet false. */
  readonly sessionValid: true;
}

const SESSION_MAX_LENGTH = 256;
const STATUS_TEXT_MAX_LENGTH = 256;

/**
 * The keepalive answer. It proves the outer gateway session only: a session identifier and a positive expiry. It never says
 * whether the brokerage is ready; that comes from brokerage.status alone. Fail closed: a missing or mistyped field is
 * BROKER_RESPONSE_INVALID, and an expiry of zero or less is an expired session (BROKER_AUTH_REQUIRED). The session identifier
 * is checked and then dropped: it is never returned, logged or stored.
 */
export function parseTickle(body: unknown): TickleResult {
  const obj = objectAt(body, 'tickle');
  const session = obj.session;
  if (typeof session !== 'string' || session.length === 0 || session.length > SESSION_MAX_LENGTH) throw invalid('tickle.session');
  const expires = obj.ssoExpires;
  if (typeof expires !== 'number' || !Number.isFinite(expires)) throw invalid('tickle.ssoExpires');
  if (expires <= 0) throw new IbkrError('BROKER_AUTH_REQUIRED', 'the gateway session has expired');
  return { sessionValid: true };
}

export interface BrokerageStatusResult {
  readonly authenticated: boolean;
  readonly connected: boolean;
  readonly competing: boolean;
  readonly established: boolean;
}

/** A required flag: a JSON boolean. A missing or differently typed flag is refused, never read as false. */
function requiredBoolean(obj: Record<string, unknown>, key: string, path: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') throw invalid(path + '.' + key);
  return value;
}

/** An optional status text: absent or null is fine; anything else must be a string of bounded length. Its content is not used. */
function optionalStatusText(obj: Record<string, unknown>, key: string, path: string): void {
  const value = obj[key];
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value.length > STATUS_TEXT_MAX_LENGTH) throw invalid(path + '.' + key);
}

/**
 * The official brokerage status (POST /iserver/auth/status), the only source of brokerage readiness. Fail closed: the four
 * flags are required booleans, and an incomplete or mistyped answer is BROKER_RESPONSE_INVALID. message and fail are optional
 * bounded texts; they are validated and never returned.
 */
export function parseBrokerageStatus(body: unknown): BrokerageStatusResult {
  const obj = objectAt(body, 'brokerage status');
  const result: BrokerageStatusResult = {
    authenticated: requiredBoolean(obj, 'authenticated', 'brokerage status'),
    connected: requiredBoolean(obj, 'connected', 'brokerage status'),
    competing: requiredBoolean(obj, 'competing', 'brokerage status'),
    established: requiredBoolean(obj, 'established', 'brokerage status'),
  };
  optionalStatusText(obj, 'message', 'brokerage status');
  optionalStatusText(obj, 'fail', 'brokerage status');
  return result;
}

/** The single NEXUS readiness rule: authenticated, connected and established, and not competing with another connection. */
export function isBrokerageReady(status: BrokerageStatusResult): boolean {
  return status.authenticated && status.connected && status.established && !status.competing;
}

/**
 * The brokerage accounts after a brokerage start. An empty answer is not a started session: it is refused here.
 */
export function parseBrokerageAccounts(body: unknown): string[] {
  const list = Array.isArray(body) ? body : objectAt(body, 'iserver accounts').accounts;
  const accounts = arrayAt(list, 'iserver.accounts', IBKR_MAX_ACCOUNTS).map((entry, index) => {
    if (typeof entry !== 'string' || !ACCOUNT_ID.test(entry)) throw invalid('iserver.accounts[' + index + ']');
    return entry;
  });
  if (accounts.length === 0) throw invalid('no brokerage account after initialization');
  return accounts;
}

export function parseAccounts(body: unknown): string[] {
  return arrayAt(body, 'accounts', IBKR_MAX_ACCOUNTS).map((entry, index) => {
    const path = 'accounts[' + index + ']';
    const obj = objectAt(entry, path);
    const id = stringField(obj, 'id', path, ACCOUNT_ID);
    if (obj.accountId !== undefined && obj.accountId !== id) throw invalid(path + '.accountId');
    return id;
  });
}

export interface AccountMeta {
  readonly currency: string;
  /** IBKR clearing status: 'O' = open. Null when not reported. */
  readonly clearingStatus: string | null;
}

export function parseMeta(body: unknown, accountId: string): AccountMeta {
  const obj = objectAt(body, 'meta');
  if (obj.id !== accountId) throw invalid('meta.id');
  return {
    currency: stringField(obj, 'currency', 'meta', CURRENCY),
    clearingStatus: optionalString(obj, 'clearingStatus', 'meta', 4),
  };
}

export interface LedgerCash {
  readonly currency: string;
  readonly cashBalance: Decimal;
}

/** Per-currency ledger entries. The 'BASE' entry repeats the base currency and is skipped, so no amount is counted twice. */
export function parseLedger(body: unknown): LedgerCash[] {
  const obj = objectAt(body, 'ledger');
  const cash: LedgerCash[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'BASE') continue;
    if (!CURRENCY.test(key)) throw invalid('ledger key');
    const entry = objectAt(value, 'ledger.' + key);
    if (entry.currency !== undefined && entry.currency !== key) throw invalid('ledger.' + key + '.currency');
    cash.push({ currency: key, cashBalance: decimal(entry.cashbalance, 'ledger.' + key + '.cashbalance') });
  }
  return cash;
}

export interface PositionRecord {
  readonly brokerInstrumentId: string;
  readonly brokerSymbol: string;
  readonly listingExchange: string | null;
  readonly quantity: Decimal;
  readonly currency: string;
  readonly averageCost: Decimal | null;
  readonly marketValue: Decimal | null;
  readonly unrealizedPnl: Decimal | null;
  /** The official reference describes this as the profit made today through trades, not a lifetime figure. */
  readonly realizedPnl: Decimal | null;
}

export function parsePositions(body: unknown, accountId: string): PositionRecord[] {
  return arrayAt(body, 'positions', IBKR_PORTFOLIO_PAGE_SIZE).map((entry, index) => {
    const path = 'positions[' + index + ']';
    const obj = objectAt(entry, path);
    if (obj.acctId !== accountId) throw invalid(path + '.acctId');
    const brokerSymbol = obj.contractDesc;
    if (typeof brokerSymbol !== 'string' || brokerSymbol.length === 0 || brokerSymbol.length > 64) throw invalid(path + '.contractDesc');
    return {
      brokerInstrumentId: identifier(obj.conid, path + '.conid'),
      brokerSymbol,
      listingExchange: optionalString(obj, 'listingExchange', path, 32),
      quantity: decimal(obj.position, path + '.position'),
      currency: stringField(obj, 'currency', path, CURRENCY),
      averageCost: optionalDecimal(obj.avgCost, path + '.avgCost'),
      marketValue: optionalDecimal(obj.mktValue, path + '.mktValue'),
      unrealizedPnl: optionalDecimal(obj.unrealizedPnl, path + '.unrealizedPnl'),
      realizedPnl: optionalDecimal(obj.realizedPnl, path + '.realizedPnl'),
    };
  });
}

export interface OrderRecord {
  readonly externalOrderId: string;
  readonly brokerInstrumentId: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: Decimal;
  readonly status: string;
}

/** Read-only: open and recently filled or cancelled orders of the session. Order fields are never used to act. */
export function parseOrders(body: unknown, accountId: string): OrderRecord[] {
  const obj = objectAt(body, 'orders');
  return arrayAt(obj.orders, 'orders.orders', IBKR_MAX_ORDERS).map((entry, index) => {
    const path = 'orders[' + index + ']';
    const order = objectAt(entry, path);
    if (order.acct !== accountId) throw invalid(path + '.acct');
    if (order.side !== 'BUY' && order.side !== 'SELL') throw invalid(path + '.side');
    return {
      externalOrderId: identifier(order.orderId, path + '.orderId'),
      brokerInstrumentId: identifier(order.conid, path + '.conid'),
      side: order.side === 'BUY' ? 'buy' : 'sell',
      quantity: decimal(order.totalSize, path + '.totalSize'),
      status: stringField(order, 'status', path, STATUS_TEXT),
    };
  });
}
