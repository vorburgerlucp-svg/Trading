// Read-only broker sync. BrokerSyncAdapter is deliberately separate from BrokerAdapter (orders): it has no method that
// could place, modify or cancel anything. Broker state is an observation, never the Capital Ledger: reconciliation reports
// differences and never corrects them, and nothing here books a trade, a deposit or a withdrawal.

import type { AdapterConnection } from '../ai/model-adapter.js';
import { parseAccountKey } from '../capital/accounts.js';
import type { AccountBalance, AccountKey, PositionView } from '../capital/capital-types.js';
import type { Decimal } from '../money/decimal.js';
import { formatChf, rappen } from '../money/money.js';
import { formatMoney, toRappen, type CurrencyCode, type Money } from '../money/currency.js';

/** A broker amount with full precision: per-share prices are not always whole minor units. */
export interface BrokerAmount {
  readonly currency: CurrencyCode;
  readonly value: Decimal;
}

export interface BrokerPositionSnapshot {
  /** NEXUS instrument behind the broker contract, or null when no mapping exists. Never invented. */
  instrumentId: string | null;
  brokerSymbol: string;
  /** The broker's stable contract identifier (IBKR conid). Identity is this id, never the ticker. */
  brokerInstrumentId?: string | null;
  listingExchange?: string | null;
  quantity: Decimal;
  currency: CurrencyCode;
  averageCost: BrokerAmount | null;
  marketValue: BrokerAmount | null;
  unrealizedPnl: BrokerAmount | null;
  realizedPnl: BrokerAmount | null;
}

export interface BrokerOpenOrder {
  externalOrderId: string;
  instrumentId: string | null;
  brokerInstrumentId?: string | null;
  side: 'buy' | 'sell';
  quantity: Decimal;
  limitPrice: BrokerAmount | null;
  status: string;
}

export interface BrokerSnapshot {
  broker: string;
  /** The full account identity. In memory only: it is persisted and shown as a masked reference. */
  accountId: string;
  access: 'read_only';
  observedAt: string;
  retrievedAt: string;
  /** Broker status code of the account (IBKR: 'O' = open). Null when the broker does not report it. */
  accountStatus?: string | null;
  cash: Money[];
  positions: BrokerPositionSnapshot[];
  /** null = open orders could not be read: unknown, never shown as "no orders". [] = read, none open. */
  openOrders: BrokerOpenOrder[] | null;
}

export interface BrokerSyncAdapter {
  readonly broker: string;
  readonly access: 'read_only';
  connection(): AdapterConnection;
  fetchSnapshot(): Promise<BrokerSnapshot>;
}

export class BrokerSyncNotConnectedError extends Error {
  override readonly name = 'BrokerSyncNotConnectedError';
}

export class NotConnectedBrokerSync implements BrokerSyncAdapter {
  readonly access = 'read_only' as const;
  constructor(readonly broker: string) {}
  connection(): AdapterConnection {
    return 'not_connected';
  }
  async fetchSnapshot(): Promise<BrokerSnapshot> {
    throw new BrokerSyncNotConnectedError(this.broker + ' read-only sync is not connected');
  }
}

export const IBKR_SYNC: BrokerSyncAdapter = new NotConnectedBrokerSync('ibkr');
export const ETORO_SYNC: BrokerSyncAdapter = new NotConnectedBrokerSync('etoro');

export type ReconciliationIssue =
  | { kind: 'quantity_mismatch'; instrumentId: string; broker: string; ledger: string }
  | { kind: 'missing_in_ledger'; instrumentId: string; broker: string }
  | { kind: 'missing_at_broker'; instrumentId: string; ledger: string }
  | { kind: 'cash_mismatch'; broker: string; ledger: string }
  | { kind: 'unsupported_currency'; detail: string }
  | { kind: 'unmapped_broker_instrument'; brokerInstrumentId: string; detail: string }
  | { kind: 'open_orders_unknown' };

export interface ReconciliationReport {
  broker: string;
  observedAt: string;
  matched: boolean;
  issues: ReconciliationIssue[];
}

/**
 * Compares a broker snapshot with the ledger (positions of this broker, CHF cash of this broker including its reservations).
 * Non-CHF cash is reported as unsupported until the ledger is multi-currency; nothing is converted or guessed.
 * A broker position without a NEXUS mapping is reported and never matched to a ledger position.
 */
export function reconcileBrokerSnapshot(
  snapshot: BrokerSnapshot,
  ledger: { portfolio: { readonly positions: readonly PositionView[] }; balances: ReadonlyMap<AccountKey, AccountBalance> },
): ReconciliationReport {
  const issues: ReconciliationIssue[] = [];
  const ledgerPositions = new Map(ledger.portfolio.positions.filter((p) => p.brokerId === snapshot.broker && p.isOpen).map((p) => [p.instrumentId, p]));
  const seen = new Set<string>();

  for (const position of snapshot.positions) {
    if (position.instrumentId === null) {
      issues.push({ kind: 'unmapped_broker_instrument', brokerInstrumentId: position.brokerInstrumentId ?? position.brokerSymbol, detail: 'position has no NEXUS instrument mapping' });
      continue;
    }
    if (seen.has(position.instrumentId)) {
      issues.push({ kind: 'unmapped_broker_instrument', brokerInstrumentId: position.brokerInstrumentId ?? position.brokerSymbol, detail: 'two broker contracts map to the same NEXUS instrument' });
      continue;
    }
    seen.add(position.instrumentId);
    const held = ledgerPositions.get(position.instrumentId);
    if (!held) issues.push({ kind: 'missing_in_ledger', instrumentId: position.instrumentId, broker: position.quantity.toString() });
    else if (!held.quantity.eq(position.quantity)) issues.push({ kind: 'quantity_mismatch', instrumentId: position.instrumentId, broker: position.quantity.toString(), ledger: held.quantity.toString() });
    ledgerPositions.delete(position.instrumentId);
  }
  for (const [instrumentId, held] of ledgerPositions) issues.push({ kind: 'missing_at_broker', instrumentId, ledger: held.quantity.toString() });

  if (snapshot.openOrders === null) {
    issues.push({ kind: 'open_orders_unknown' });
  } else {
    for (const order of snapshot.openOrders) {
      if (order.instrumentId === null) issues.push({ kind: 'unmapped_broker_instrument', brokerInstrumentId: order.brokerInstrumentId ?? order.externalOrderId, detail: 'open order has no NEXUS instrument mapping' });
    }
  }

  for (const cash of snapshot.cash) {
    if (cash.currency !== 'CHF') {
      issues.push({ kind: 'unsupported_currency', detail: formatMoney(cash) + ' cannot be reconciled: ledger is CHF-only' });
      continue;
    }
    const brokerCash = toRappen(cash);
    // Broker cash includes amounts held for open orders (reservations hang off the broker cash account).
    let ledgerCash = 0n;
    for (const [key, balance] of ledger.balances) {
      const info = parseAccountKey(key);
      if ((info.kind === 'cash' || info.kind === 'cash_reservation') && info.cashType === 'broker' && info.cashId === snapshot.broker) ledgerCash += balance.amount;
    }
    if (brokerCash !== ledgerCash) issues.push({ kind: 'cash_mismatch', broker: formatChf(brokerCash), ledger: formatChf(rappen(ledgerCash)) });
  }
  return { broker: snapshot.broker, observedAt: snapshot.observedAt, matched: issues.length === 0, issues };
}
