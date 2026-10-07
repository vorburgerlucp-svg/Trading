// Portfolio views derived from ledger balances + market data.
// Quantities, cost basis, realized P&L and fees come from the ledger only.
// Market values exist only when a fresh quote (and FX rate) is supplied; otherwise they are null
// and the position is carried at cost, flagged as DATA NOT CONNECTED / stale.

import { Decimal } from '../money/decimal.js';
import { chfRounded, chfToDecimal, rappen, subChf, ZERO_CHF, type Rappen } from '../money/money.js';
import { accounts, parseAccountKey } from './accounts.js';
import {
  BASE_CURRENCY,
  type AccountBalance,
  type AccountKey,
  type DataStatus,
  type InstrumentInfo,
  type InventoryHoldingView,
  type InventoryMarketQuote,
  type MarketDataSnapshot,
  type PositionView,
  type PriceQuote,
  type PriceStatus,
} from './capital-types.js';

export interface ValuationContext {
  /** Valuation time; quote age is measured against it. */
  asOf: string;
  maxQuoteAgeMs: number;
  market?: MarketDataSnapshot;
  instruments?: readonly InstrumentInfo[];
}

const ZERO_BALANCE: AccountBalance = { amount: ZERO_CHF, quantity: Decimal.ZERO };

export function positionKey(brokerId: string, instrumentId: string): string {
  return brokerId + ':' + instrumentId;
}

export function derivePositions(balances: ReadonlyMap<AccountKey, AccountBalance>, context: ValuationContext): PositionView[] {
  const ids = new Map<string, { brokerId: string; instrumentId: string }>();
  for (const key of balances.keys()) {
    const info = parseAccountKey(key);
    if (info.kind === 'position' || info.kind === 'trading_pnl') {
      ids.set(positionKey(info.brokerId, info.instrumentId), { brokerId: info.brokerId, instrumentId: info.instrumentId });
    } else if (info.kind === 'expense' && info.feeKind === 'trading' && info.scope.length === 2) {
      const [brokerId = '', instrumentId = ''] = info.scope;
      ids.set(positionKey(brokerId, instrumentId), { brokerId, instrumentId });
    }
  }

  const instruments = new Map((context.instruments ?? []).map((i) => [i.instrumentId, i]));
  const asOfMs = Date.parse(context.asOf);

  return [...ids.values()]
    .sort((a, b) => compareText(positionKey(a.brokerId, a.instrumentId), positionKey(b.brokerId, b.instrumentId)))
    .map(({ brokerId, instrumentId }) => {
      const holding = balances.get(accounts.position(brokerId, instrumentId)) ?? ZERO_BALANCE;
      const realizedPnlChf = rappen(-(balances.get(accounts.tradingPnl(brokerId, instrumentId))?.amount ?? 0n));
      const feesChf = rappen(balances.get(accounts.fee('trading', brokerId, instrumentId))?.amount ?? 0n);
      const instrument = instruments.get(instrumentId);
      const isOpen = !holding.quantity.isZero();
      const valuation = isOpen ? valuePosition(holding.quantity, instrumentId, context.market, asOfMs, context.maxQuoteAgeMs) : null;
      const marketValueChf = valuation?.marketValueChf ?? null;

      return {
        brokerId,
        instrumentId,
        symbol: instrument?.symbol ?? null,
        assetClass: instrument?.assetClass ?? null,
        isOpen,
        quantity: holding.quantity,
        costBasisChf: holding.amount,
        averageCostChf: isOpen ? chfToDecimal(holding.amount).dividedBy(holding.quantity, 8, 'half_even') : null,
        priceStatus: valuation?.status ?? 'not_connected',
        lastQuote: valuation?.quote ?? null,
        marketValueChf,
        unrealizedPnlChf: marketValueChf === null ? null : subChf(marketValueChf, holding.amount),
        realizedPnlChf,
        feesChf,
        carryingValueChf: marketValueChf ?? holding.amount,
        settlementDays: instrument?.settlementDays ?? null,
      };
    });
}

function valuePosition(
  quantity: Decimal,
  instrumentId: string,
  market: MarketDataSnapshot | undefined,
  asOfMs: number,
  maxAgeMs: number,
): { status: PriceStatus; quote: PriceQuote | null; marketValueChf: Rappen | null } {
  const quote = latest((market?.quotes ?? []).filter((q) => q.instrumentId === instrumentId));
  if (!quote) return { status: 'not_connected', quote: null, marketValueChf: null };
  if (!isFresh(quote.asOf, asOfMs, maxAgeMs)) return { status: 'stale', quote, marketValueChf: null };

  let valueInQuoteCurrency = quantity.times(quote.price);
  if (quote.currency !== BASE_CURRENCY) {
    const fx = latest((market?.fxRates ?? []).filter((r) => r.currency === quote.currency));
    if (!fx) return { status: 'not_connected', quote, marketValueChf: null };
    if (!isFresh(fx.asOf, asOfMs, maxAgeMs)) return { status: 'stale', quote, marketValueChf: null };
    valueInQuoteCurrency = valueInQuoteCurrency.times(fx.rate);
  }
  // Single rounding step on the exact product (no double rounding).
  return { status: 'live', quote, marketValueChf: chfRounded(valueInQuoteCurrency, 'half_even') };
}

export function deriveInventoryHoldings(
  balances: ReadonlyMap<AccountKey, AccountBalance>,
  quotes: readonly InventoryMarketQuote[],
  asOf: string,
  maxAgeMs: number,
): InventoryHoldingView[] {
  const products = new Set<string>();
  for (const key of balances.keys()) {
    const info = parseAccountKey(key);
    if (info.kind === 'inventory') products.add(info.productId);
  }
  const asOfMs = Date.parse(asOf);

  return [...products].sort(compareText).map((productId) => {
    const free = balances.get(accounts.inventory(productId)) ?? ZERO_BALANCE;
    const reserved = balances.get(accounts.inventoryReserved(productId)) ?? ZERO_BALANCE;
    const quantityOnHand = free.quantity.plus(reserved.quantity);
    const costBasisChf = rappen(free.amount + reserved.amount);
    const quote = latest(quotes.filter((q) => q.productId === productId));
    let marketDataStatus: DataStatus = 'not_connected';
    let marketValueChf: Rappen | null = null;
    if (quote) {
      marketDataStatus = isFresh(quote.asOf, asOfMs, maxAgeMs) ? 'connected' : 'stale';
      if (marketDataStatus === 'connected') marketValueChf = chfRounded(chfToDecimal(quote.unitPriceChf).times(quantityOnHand), 'half_even');
    }
    return {
      productId,
      quantityOnHand,
      quantityReserved: reserved.quantity,
      costBasisChf,
      averageUnitCostChf: quantityOnHand.isZero() ? null : chfToDecimal(costBasisChf).dividedBy(quantityOnHand, 8, 'half_even'),
      marketValueChf,
      marketDataStatus,
    };
  });
}

function latest<T extends { asOf: string }>(items: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (best === undefined || Date.parse(item.asOf) > Date.parse(best.asOf)) best = item;
  }
  return best;
}

function isFresh(asOf: string, nowMs: number, maxAgeMs: number): boolean {
  const ts = Date.parse(asOf);
  if (Number.isNaN(ts)) return false;
  return nowMs - ts <= maxAgeMs && ts <= nowMs + 60_000;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
