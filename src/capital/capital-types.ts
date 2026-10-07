import type { AssetClass } from '../contracts.js';
import type { Decimal } from '../money/decimal.js';
import type { Rappen } from '../money/money.js';

export const BASE_CURRENCY = 'CHF' as const;
export type BaseCurrency = typeof BASE_CURRENCY;

// ---------------------------------------------------------------------------
// Chart of accounts (double-entry). Keys are colon-separated paths, see accounts.ts.
// ---------------------------------------------------------------------------

export type AccountKey = string;
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type CashType = 'bank' | 'broker' | 'crypto' | 'physical';

/** earmark: internal decision; open_order / purchase_commitment: promised to a third party. */
export type ReservationPurpose = 'earmark' | 'open_order' | 'purchase_commitment';

export type FeeKind = 'trading' | 'marketplace' | 'payment' | 'bank' | 'custody' | 'fx' | 'other';
export type ExpenseCategory = 'fee' | 'shipping' | 'advertising' | 'returns' | 'tax' | 'other';

export type AccountInfo =
  | { kind: 'cash'; type: 'asset'; key: AccountKey; cashType: CashType; cashId: string }
  | {
      kind: 'cash_reservation';
      type: 'asset';
      key: AccountKey;
      cashType: CashType;
      cashId: string;
      parent: AccountKey;
      purpose: ReservationPurpose;
      reservationId: string;
    }
  | { kind: 'position'; type: 'asset'; key: AccountKey; brokerId: string; instrumentId: string }
  | { kind: 'inventory'; type: 'asset'; key: AccountKey; productId: string; reserved: boolean }
  | { kind: 'receivable'; type: 'asset'; key: AccountKey; counterpartyId: string }
  | { kind: 'payable'; type: 'liability'; key: AccountKey; counterpartyId: string }
  | { kind: 'tax_payable'; type: 'liability'; key: AccountKey; taxKind: string }
  | { kind: 'contributions'; type: 'equity'; key: AccountKey }
  | { kind: 'trading_pnl'; type: 'income'; key: AccountKey; brokerId: string; instrumentId: string }
  | { kind: 'sales_revenue'; type: 'income'; key: AccountKey; productId: string }
  | { kind: 'other_income'; type: 'income'; key: AccountKey; incomeKind: string }
  | { kind: 'cogs'; type: 'expense'; key: AccountKey; productId: string }
  | { kind: 'expense'; type: 'expense'; key: AccountKey; category: ExpenseCategory; feeKind?: FeeKind; scope: string[] };

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type CapitalTransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'trade_buy'
  | 'trade_sell'
  | 'inventory_buy'
  | 'inventory_sale'
  | 'fee'
  | 'shipping'
  | 'tax'
  | 'expense'
  | 'transfer'
  | 'liability_payment'
  | 'reserve'
  | 'release_reserve'
  | 'reversal';

export const CAPITAL_TRANSACTION_TYPES: readonly CapitalTransactionType[] = [
  'deposit',
  'withdrawal',
  'trade_buy',
  'trade_sell',
  'inventory_buy',
  'inventory_sale',
  'fee',
  'shipping',
  'tax',
  'expense',
  'transfer',
  'liability_payment',
  'reserve',
  'release_reserve',
  'reversal',
];

/**
 * One leg of a journal entry. Debit = positive, credit = negative.
 * Asset/expense accounts carry positive balances, liability/equity/income accounts negative ones.
 * `quantity` is only allowed on position and inventory accounts (shares, coins, pieces).
 */
export interface Posting {
  readonly account: AccountKey;
  readonly amount: Rappen;
  readonly quantity?: Decimal;
}

export interface EntryRefs {
  readonly opportunityId?: string;
  readonly tradeId?: string;
  readonly inventoryId?: string;
  readonly instrumentId?: string;
  readonly brokerId?: string;
  readonly reservationId?: string;
  /** ID at the external system (broker execution ID, marketplace order, bank booking). */
  readonly externalRef?: string;
  readonly reversesEntryId?: string;
}

export type EntrySource = 'engine' | 'manual' | 'broker_sync' | 'import';

export interface JournalEntryDraft {
  /** Unique and stable: doubles as idempotency key (re-sending the same ID is rejected). */
  id: string;
  /** Economic time of the event (ISO 8601). */
  occurredAt: string;
  type: CapitalTransactionType;
  description: string;
  postings: readonly Posting[];
  refs?: EntryRefs;
  source?: EntrySource;
}

/** Immutable, hash-chained ledger entry. */
export interface JournalEntry {
  readonly sequence: number;
  readonly id: string;
  readonly occurredAt: string;
  /** Time the entry was appended to the ledger. */
  readonly recordedAt: string;
  readonly type: CapitalTransactionType;
  readonly description: string;
  readonly postings: readonly Posting[];
  readonly refs: EntryRefs;
  readonly source: EntrySource;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AccountBalance {
  readonly amount: Rappen;
  readonly quantity: Decimal;
}

// ---------------------------------------------------------------------------
// Market data (never invented: missing data stays missing and is flagged)
// ---------------------------------------------------------------------------

export type DataStatus = 'connected' | 'stale' | 'not_connected';
export type CoverageStatus = 'complete' | 'partial' | 'not_connected' | 'not_required';

export interface InstrumentInfo {
  instrumentId: string;
  symbol: string;
  name?: string;
  assetClass: AssetClass;
  currency: string;
  /** Days until sale proceeds are settled (T+n). */
  settlementDays: number;
}

export interface PriceQuote {
  instrumentId: string;
  price: Decimal;
  currency: string;
  asOf: string;
  source: string;
}

/** 1 `currency` = `rate` CHF. */
export interface FxRate {
  currency: string;
  rate: Decimal;
  asOf: string;
  source: string;
}

export interface MarketDataSnapshot {
  quotes: readonly PriceQuote[];
  fxRates?: readonly FxRate[];
}

export interface InventoryMarketQuote {
  productId: string;
  unitPriceChf: Rappen;
  asOf: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface CapitalPolicy {
  /** Safety reserve = max(minimumChf, netWorth * percentOfNetWorthBp / 10'000), rounded up. */
  safetyReserve: {
    minimumChf: Rappen;
    percentOfNetWorthBp: number;
  };
  /** Market quotes / FX rates older than this are stale and not used for valuation. */
  maxQuoteAgeMs: number;
  /** Observed resale prices for inventory are slower-moving; separate freshness limit. */
  maxInventoryQuoteAgeMs: number;
}

// ---------------------------------------------------------------------------
// Derived state (never stored; always recomputed from the ledger + market data)
// ---------------------------------------------------------------------------

export type PriceStatus = 'live' | 'stale' | 'not_connected';

export interface PositionView {
  brokerId: string;
  instrumentId: string;
  symbol: string | null;
  assetClass: AssetClass | null;
  isOpen: boolean;
  quantity: Decimal;
  costBasisChf: Rappen;
  /** Cost basis per unit in CHF, null for closed positions. */
  averageCostChf: Decimal | null;
  priceStatus: PriceStatus;
  lastQuote: PriceQuote | null;
  marketValueChf: Rappen | null;
  unrealizedPnlChf: Rappen | null;
  realizedPnlChf: Rappen;
  feesChf: Rappen;
  /** Market value when a fresh quote exists, otherwise cost basis. This is what counts towards net worth. */
  carryingValueChf: Rappen;
  settlementDays: number | null;
}

export interface InventoryHoldingView {
  productId: string;
  quantityOnHand: Decimal;
  quantityReserved: Decimal;
  costBasisChf: Rappen;
  averageUnitCostChf: Decimal | null;
  marketValueChf: Rappen | null;
  marketDataStatus: DataStatus;
}

export interface CapitalState {
  timestamp: string;
  baseCurrency: BaseCurrency;

  /** Cash + financial assets (carrying value) + inventory at cost + receivables - liabilities. */
  totalNetWorthChf: Rappen;

  /** Balances per cash type, including reserved sub-accounts. */
  cash: {
    bankChf: Rappen;
    brokerCashChf: Rappen;
    cryptoCashChf: Rappen;
    physicalCashChf: Rappen;
    totalChf: Rappen;
    /** Cash not held in any reservation. */
    unreservedChf: Rappen;
  };

  /** Internal earmarks (decided by us, can be released). */
  reservedCapitalChf: Rappen;
  /** Promised to third parties: open orders + purchase commitments. */
  committedCapitalChf: Rappen;
  safetyReserveChf: Rappen;

  /** Unreserved cash - liabilities - safety reserve, floored at 0. Receivables do not count until paid. */
  availableCapitalChf: Rappen;
  /** How far unreserved cash falls short of liabilities + safety reserve. */
  capitalShortfallChf: Rappen;

  financialAssetsChf: Rappen;
  financialAssetsCostChf: Rappen;
  physicalInventoryCostChf: Rappen;
  /** Null as long as no inventory market data is connected. Not used for net worth. */
  physicalInventoryMarketValueChf: Rappen | null;
  receivablesChf: Rappen;
  liabilitiesChf: Rappen;

  /** Financial assets + inventory: capital deployed in opportunities. */
  investedCapitalChf: Rappen;
  /** Invested + reserved + committed: capital that is not freely available ("gebundenes Kapital"). */
  boundCapitalChf: Rappen;

  /** Deposits - withdrawals. */
  netContributionsChf: Rappen;
  pnl: {
    /** Income - expenses booked in the ledger (realized trades, sales, fees, costs). */
    realizedChf: Rappen;
    /** Null when at least one open position has no fresh quote. */
    unrealizedChf: Rappen | null;
    /** Net worth - net contributions. */
    totalChf: Rappen;
    /** total / net contributions, in basis points. Simple return, not time-weighted. */
    returnSinceStartBp: number | null;
  };

  dataStatus: {
    financialMarketData: CoverageStatus;
    inventoryMarketData: CoverageStatus;
    unpricedPositions: string[];
    stalePositions: string[];
  };
}

/** Full portfolio state: aggregate capital figures plus the holdings they are built from. */
export interface PortfolioSnapshot {
  capital: CapitalState;
  positions: readonly PositionView[];
  inventory: readonly InventoryHoldingView[];
}
