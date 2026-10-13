// Read-only broker sync (prepared, not connected).
// BrokerSyncAdapter is deliberately separate from BrokerAdapter (orders): it has no method that
// could place, modify or cancel anything. The first real sync (IBKR preferred, eToro second) will
// import snapshots and fills into the ledger as `broker_sync` entries after reconciliation.

import type { AdapterConnection } from '../ai/model-adapter.js';
import { parseAccountKey } from '../capital/accounts.js';
import type { AccountBalance, AccountKey, PortfolioSnapshot } from '../capital/capital-types.js';
import type { Decimal } from '../money/decimal.js';
import { formatChf, rappen } from '../money/money.js';
import { formatMoney, toRappen, type CurrencyCode, type Money } from '../money/currency.js';

export interface BrokerPositionSnapshot {
  instrumentId: string;
  brokerSymbol: string;
  quantity: Decimal;
  currency: CurrencyCode;
  averageCost: Money;
  marketValue: Money | null;
  unrealizedPnl: Money | null;
  realizedPnl: Money | null;
}

export interface BrokerOpenOrder {
  externalOrderId: string;
  instrumentId: string;
  side: 'buy' | 'sell';
  quantity: Decimal;
  limitPrice: Money | null;
  status: string;
}

export interface BrokerSnapshot {
  broker: string;
  accountId: string;
  access: 'read_only';
  observedAt: string;
  retrievedAt: string;
  cash: Money[];
  positions: BrokerPositionSnapshot[];
  openOrders: BrokerOpenOrder[];
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
  | { kind: 'unsupported_currency'; detail: string };

export interface ReconciliationReport {
  broker: string;
  observedAt: string;
  matched: boolean;
  issues: ReconciliationIssue[];
}

/**
 * Compares a broker snapshot with the ledger (positions of this broker, CHF cash of this broker
 * including its reservations). Non-CHF cash is reported as unsupported until the ledger is
 * multi-currency; nothing is guessed.
 */
export function reconcileBrokerSnapshot(
  snapshot: BrokerSnapshot,
  ledger: { portfolio: PortfolioSnapshot; balances: ReadonlyMap<AccountKey, AccountBalance> },
): ReconciliationReport {
  const portfolio = ledger.portfolio;
  const issues: ReconciliationIssue[] = [];
  const ledgerPositions = new Map(portfolio.positions.filter((p) => p.brokerId === snapshot.broker && p.isOpen).map((p) => [p.instrumentId, p]));

  for (const position of snapshot.positions) {
    const ledger = ledgerPositions.get(position.instrumentId);
    if (!ledger) issues.push({ kind: 'missing_in_ledger', instrumentId: position.instrumentId, broker: position.quantity.toString() });
    else if (!ledger.quantity.eq(position.quantity)) issues.push({ kind: 'quantity_mismatch', instrumentId: position.instrumentId, broker: position.quantity.toString(), ledger: ledger.quantity.toString() });
    ledgerPositions.delete(position.instrumentId);
  }
  for (const [instrumentId, ledger] of ledgerPositions) issues.push({ kind: 'missing_at_broker', instrumentId, ledger: ledger.quantity.toString() });

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
