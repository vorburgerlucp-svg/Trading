// Normalized, time-free content of a broker snapshot. Its fingerprint identifies the observed state: the same state observed
// again has the same fingerprint and therefore never creates a second, different record. Times are kept beside the content,
// never inside it. The account appears only as a masked reference.

import { canonicalJson, hashOf } from '../persistence/canonical-json.js';
import { moneyToDecimal, type Money } from '../money/currency.js';
import type { BrokerAmount, BrokerSnapshot } from './broker-sync.js';

export const BROKER_SNAPSHOT_MODEL_VERSION = 'broker-snapshot:v1' as const;

/** Keeps the first and last three characters: enough to recognise the account, not enough to reconstruct it. */
export function maskAccountId(accountId: string): string {
  return accountId.length >= 6 ? accountId.slice(0, 1) + '****' + accountId.slice(-3) : '****';
}

export interface AmountContent {
  currency: string;
  amount: string;
}

export interface PositionContent {
  instrumentId: string | null;
  brokerInstrumentId: string | null;
  brokerSymbol: string;
  listingExchange: string | null;
  quantity: string;
  currency: string;
  averageCost: AmountContent | null;
  marketValue: AmountContent | null;
  unrealizedPnl: AmountContent | null;
  realizedPnl: AmountContent | null;
}

export interface OrderContent {
  externalOrderId: string;
  instrumentId: string | null;
  brokerInstrumentId: string | null;
  side: 'buy' | 'sell';
  quantity: string;
  limitPrice: AmountContent | null;
  status: string;
}

export interface BrokerSnapshotContent {
  version: typeof BROKER_SNAPSHOT_MODEL_VERSION;
  broker: string;
  accountRef: string;
  access: 'read_only';
  accountStatus: string | null;
  cash: AmountContent[];
  positions: PositionContent[];
  /** null = unknown (not read). [] = read, none open. */
  openOrders: OrderContent[] | null;
}

function fromBrokerAmount(value: BrokerAmount | null): AmountContent | null {
  return value === null ? null : { currency: value.currency, amount: value.value.toString() };
}

function fromMoney(value: Money): AmountContent {
  return { currency: value.currency, amount: moneyToDecimal(value).toString() };
}

/** Sorted by canonical text, so the order of the broker response never changes the fingerprint. */
function sorted<T>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0));
}

export function normalizeBrokerSnapshot(snapshot: BrokerSnapshot): BrokerSnapshotContent {
  return {
    version: BROKER_SNAPSHOT_MODEL_VERSION,
    broker: snapshot.broker,
    accountRef: maskAccountId(snapshot.accountId),
    access: 'read_only',
    accountStatus: snapshot.accountStatus ?? null,
    cash: sorted(snapshot.cash.map(fromMoney)),
    positions: sorted(
      snapshot.positions.map((p) => ({
        instrumentId: p.instrumentId,
        brokerInstrumentId: p.brokerInstrumentId ?? null,
        brokerSymbol: p.brokerSymbol,
        listingExchange: p.listingExchange ?? null,
        quantity: p.quantity.toString(),
        currency: p.currency,
        averageCost: fromBrokerAmount(p.averageCost),
        marketValue: fromBrokerAmount(p.marketValue),
        unrealizedPnl: fromBrokerAmount(p.unrealizedPnl),
        realizedPnl: fromBrokerAmount(p.realizedPnl),
      })),
    ),
    openOrders:
      snapshot.openOrders === null
        ? null
        : sorted(
            snapshot.openOrders.map((o) => ({
              externalOrderId: o.externalOrderId,
              instrumentId: o.instrumentId,
              brokerInstrumentId: o.brokerInstrumentId ?? null,
              side: o.side,
              quantity: o.quantity.toString(),
              limitPrice: fromBrokerAmount(o.limitPrice),
              status: o.status,
            })),
          ),
  };
}

export function brokerSnapshotFingerprint(content: BrokerSnapshotContent): string {
  return hashOf(content);
}
