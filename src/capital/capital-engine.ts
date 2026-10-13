// Capital Engine: the only write path for capital movements, and the source of the CapitalState.
//
// Commands translate business events (deposit, trade fill, fee, reservation, ...) into balanced
// journal entries. Business rules are enforced inside the ledger's write critical section (which the
// store makes cross-process), against the true latest state:
//  - no cash, reservation or receivable account may go negative (no overdraft / double spend)
//  - positions and inventory may not go below zero quantity (no shorting / overselling in v0.2)
//  - an emptied position or stock item may not keep a residual cost basis
//  - liabilities cannot be overpaid
//
// Idempotency: every command has an id (pass the external event id, e.g.
// "broker-fill:ibkr:ORDER123:FILL4"; otherwise a random one is generated) and a fingerprint of its
// input. Replaying the same command returns ALREADY_APPLIED and books nothing.
//
// Nothing here talks to a broker or supplier. Broker fills and marketplace sales are *recorded*
// after they happened; execution lives behind BrokerAdapter and stays locked.

import { randomUUID } from 'node:crypto';
import { Decimal, type DecimalInput } from '../money/decimal.js';
import {
  applyBp,
  maxChf,
  negChf,
  nonNegativeChf,
  prorateChf,
  ratioBp,
  rappen,
  subChf,
  sumChf,
  ZERO_CHF,
  type Rappen,
} from '../money/money.js';
import { hashOf } from '../persistence/canonical-json.js';
import { accounts, isCashLike, parseAccountKey } from './accounts.js';
import { LedgerError, type AppendResult, type CapitalLedger, type DraftFactory, type LedgerView } from './capital-ledger.js';
import {
  BASE_CURRENCY,
  type AccountBalance,
  type AccountKey,
  type CapitalPolicy,
  type CapitalState,
  type CapitalTransactionType,
  type CoverageStatus,
  type EntryRefs,
  type ExpenseCategory,
  type FeeKind,
  type InstrumentInfo,
  type InventoryMarketQuote,
  type JournalEntryDraft,
  type MarketDataSnapshot,
  type PortfolioSnapshot,
  type Posting,
  type ReservationPurpose,
} from './capital-types.js';
import { deriveInventoryHoldings, derivePositions, positionKey } from './portfolio.js';

export class CapitalRuleError extends Error {
  override readonly name = 'CapitalRuleError';
}

export interface CapitalEngineOptions {
  policy: CapitalPolicy;
  clock?: () => Date;
  newId?: () => string;
}

/** Fields shared by all commands. `id` is the idempotency key; pass the external event ID when there is one. */
export interface CommandMeta {
  id?: string;
  occurredAt?: string;
  description?: string;
  refs?: EntryRefs;
}

export interface SnapshotOptions {
  /** Economic time: only entries up to this instant are included. Defaults to now. */
  asOf?: string;
  market?: MarketDataSnapshot;
  instruments?: readonly InstrumentInfo[];
  inventoryQuotes?: readonly InventoryMarketQuote[];
}

type ResolvedMeta = CommandMeta & { id: string };

export class CapitalEngine {
  readonly policy: CapitalPolicy;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(
    readonly ledger: CapitalLedger,
    options: CapitalEngineOptions,
  ) {
    validatePolicy(options.policy);
    this.policy = options.policy;
    this.clock = options.clock ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  // -------------------------------------------------------------------------
  // Generic write path
  // -------------------------------------------------------------------------

  /** Appends a draft (or a draft built from the current state) after enforcing the capital rules. */
  post(draft: JournalEntryDraft | DraftFactory, options: { idempotencyKey?: string; requestFingerprint?: string } = {}): Promise<AppendResult> {
    return this.ledger.append(draft, { ...options, guard: enforceCapitalRules });
  }

  /**
   * Runs a command idempotently: resolves its id, fingerprints its (normalized) input and posts the
   * draft it builds. The fingerprint never contains defaults such as "now", so replays match.
   */
  submit(command: string, input: CommandMeta, fingerprintInput: unknown, build: (meta: ResolvedMeta) => JournalEntryDraft | DraftFactory): Promise<AppendResult> {
    const id = input.id ?? this.newId();
    return this.post(build({ ...input, id }), { idempotencyKey: id, requestFingerprint: commandFingerprint(command, fingerprintInput) });
  }

  /** Common draft fields for commands. */
  draft(
    type: CapitalTransactionType,
    meta: CommandMeta,
    defaultDescription: string,
    postings: Posting[],
    refs: EntryRefs = {},
  ): JournalEntryDraft {
    return {
      id: meta.id ?? this.newId(),
      occurredAt: meta.occurredAt ?? this.clock().toISOString(),
      type,
      description: meta.description ?? defaultDescription,
      postings: postings.filter((p) => p.amount !== 0n || (p.quantity !== undefined && !p.quantity.isZero())),
      refs: { ...refs, ...meta.refs },
      source: 'engine',
    };
  }

  /** Brings the local projection up to date with entries committed by other NEXUS processes. */
  refresh(): Promise<void> {
    return this.ledger.sync();
  }

  // -------------------------------------------------------------------------
  // Cash
  // -------------------------------------------------------------------------

  async deposit(input: CommandMeta & { to: AccountKey; amountChf: Rappen }): Promise<AppendResult> {
    requirePositive(input.amountChf, 'deposit amount');
    requireKind(input.to, ['cash'], 'deposit target');
    return this.submit('deposit', input, input, (meta) =>
      this.draft('deposit', meta, 'Deposit', [
        { account: input.to, amount: input.amountChf },
        { account: accounts.contributions, amount: negChf(input.amountChf) },
      ]),
    );
  }

  async withdraw(input: CommandMeta & { from: AccountKey; amountChf: Rappen }): Promise<AppendResult> {
    requirePositive(input.amountChf, 'withdrawal amount');
    requireKind(input.from, ['cash'], 'withdrawal source');
    return this.submit('withdraw', input, input, (meta) =>
      this.draft('withdrawal', meta, 'Withdrawal', [
        { account: input.from, amount: negChf(input.amountChf) },
        { account: accounts.contributions, amount: input.amountChf },
      ]),
    );
  }

  /** Moves cash between own accounts (e.g. bank → broker). The fee is paid by the sender. */
  async transfer(input: CommandMeta & { from: AccountKey; to: AccountKey; amountChf: Rappen; feeChf?: Rappen; feeKind?: FeeKind }): Promise<AppendResult> {
    const fee = input.feeChf ?? ZERO_CHF;
    requirePositive(input.amountChf, 'transfer amount');
    requireNonNegative(fee, 'transfer fee');
    requireKind(input.from, ['cash'], 'transfer source');
    requireKind(input.to, ['cash'], 'transfer target');
    if (input.from === input.to) throw new CapitalRuleError('transfer source and target are the same account');
    return this.submit('transfer', input, input, (meta) =>
      this.draft('transfer', meta, 'Transfer', [
        { account: input.from, amount: negChf(rappen(input.amountChf + fee)) },
        { account: input.to, amount: input.amountChf },
        { account: accounts.fee(input.feeKind ?? 'bank'), amount: fee },
      ]),
    );
  }

  // -------------------------------------------------------------------------
  // Financial markets (records fills reported by a broker; never places orders)
  // -------------------------------------------------------------------------

  /** Records a buy fill. Amounts are the broker-reported CHF amounts, not recomputed from qty x price. */
  async recordTradeBuy(
    input: CommandMeta & {
      brokerId: string;
      instrumentId: string;
      quantity: DecimalInput;
      grossAmountChf: Rappen;
      feeChf?: Rappen;
      /** Defaults to the broker's cash account; may be an open_order reservation. */
      payFrom?: AccountKey;
      tradeId?: string;
      opportunityId?: string;
    },
  ): Promise<AppendResult> {
    const quantity = requirePositiveQuantity(input.quantity);
    const fee = input.feeChf ?? ZERO_CHF;
    requirePositive(input.grossAmountChf, 'gross amount');
    requireNonNegative(fee, 'fee');
    const payFrom = input.payFrom ?? accounts.brokerCash(input.brokerId);
    requireKind(payFrom, ['cash', 'cash_reservation'], 'payment source');
    return this.submit('recordTradeBuy', input, { ...input, quantity }, (meta) =>
      this.draft(
        'trade_buy',
        meta,
        'Buy ' + quantity.toString() + ' ' + input.instrumentId + ' @ ' + input.brokerId,
        [
          { account: accounts.position(input.brokerId, input.instrumentId), amount: input.grossAmountChf, quantity },
          { account: payFrom, amount: negChf(rappen(input.grossAmountChf + fee)) },
          { account: accounts.fee('trading', input.brokerId, input.instrumentId), amount: fee },
        ],
        tradeRefs(input),
      ),
    );
  }

  /** Records a sell fill. Cost basis is released pro rata (average cost); an emptied position releases all remaining cost. */
  async recordTradeSell(
    input: CommandMeta & {
      brokerId: string;
      instrumentId: string;
      quantity: DecimalInput;
      grossProceedsChf: Rappen;
      feeChf?: Rappen;
      receiveTo?: AccountKey;
      tradeId?: string;
      opportunityId?: string;
    },
  ): Promise<AppendResult> {
    const quantity = requirePositiveQuantity(input.quantity);
    const fee = input.feeChf ?? ZERO_CHF;
    requirePositive(input.grossProceedsChf, 'gross proceeds');
    requireNonNegative(fee, 'fee');
    const receiveTo = input.receiveTo ?? accounts.brokerCash(input.brokerId);
    requireKind(receiveTo, ['cash'], 'proceeds target');
    const positionAccount = accounts.position(input.brokerId, input.instrumentId);

    return this.submit('recordTradeSell', input, { ...input, quantity }, (meta) => (current) => {
      const holding = current.balance(positionAccount);
      if (holding.quantity.lt(quantity)) {
        throw new CapitalRuleError('cannot sell ' + quantity.toString() + ' ' + input.instrumentId + ', holding ' + holding.quantity.toString());
      }
      const costReleased = releasedCost(holding, quantity);
      const realized = subChf(input.grossProceedsChf, costReleased);
      return this.draft(
        'trade_sell',
        meta,
        'Sell ' + quantity.toString() + ' ' + input.instrumentId + ' @ ' + input.brokerId,
        [
          { account: receiveTo, amount: subChf(input.grossProceedsChf, fee) },
          { account: accounts.fee('trading', input.brokerId, input.instrumentId), amount: fee },
          { account: positionAccount, amount: negChf(costReleased), quantity: quantity.negated() },
          { account: accounts.tradingPnl(input.brokerId, input.instrumentId), amount: negChf(realized) },
        ],
        tradeRefs(input),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Expenses, liabilities, receivables
  // -------------------------------------------------------------------------

  /** Fee, shipping, advertising, returns, tax or other cost; paid now (paidFrom) or owed (owedTo). */
  async recordExpense(
    input: CommandMeta & {
      category: ExpenseCategory;
      feeKind?: FeeKind;
      /** Optional sub-account scope, e.g. a product or broker ID. */
      scope?: string[];
      amountChf: Rappen;
      paidFrom?: AccountKey;
      owedTo?: AccountKey;
    },
  ): Promise<AppendResult> {
    requirePositive(input.amountChf, 'expense amount');
    if ((input.paidFrom === undefined) === (input.owedTo === undefined)) {
      throw new CapitalRuleError('expense needs exactly one of paidFrom or owedTo');
    }
    if (input.paidFrom !== undefined) requireKind(input.paidFrom, ['cash', 'cash_reservation'], 'expense payment source');
    if (input.owedTo !== undefined) requireKind(input.owedTo, ['payable', 'tax_payable'], 'expense liability');
    const scope = input.scope ?? [];
    const expenseAccount = input.category === 'fee' ? accounts.fee(input.feeKind ?? 'other', ...scope) : accounts.expense(input.category, ...scope);
    const counterAccount = input.paidFrom ?? input.owedTo ?? '';
    const type: CapitalTransactionType =
      input.category === 'fee' ? 'fee' : input.category === 'shipping' ? 'shipping' : input.category === 'tax' ? 'tax' : 'expense';
    return this.submit('recordExpense', input, input, (meta) =>
      this.draft(type, meta, 'Expense: ' + input.category, [
        { account: expenseAccount, amount: input.amountChf },
        { account: counterAccount, amount: negChf(input.amountChf) },
      ]),
    );
  }

  async payLiability(input: CommandMeta & { liability: AccountKey; from: AccountKey; amountChf: Rappen }): Promise<AppendResult> {
    requirePositive(input.amountChf, 'payment amount');
    requireKind(input.liability, ['payable', 'tax_payable'], 'liability');
    requireKind(input.from, ['cash', 'cash_reservation'], 'payment source');
    return this.submit('payLiability', input, input, (meta) =>
      this.draft('liability_payment', meta, 'Pay liability', [
        { account: input.liability, amount: input.amountChf },
        { account: input.from, amount: negChf(input.amountChf) },
      ]),
    );
  }

  /** Payout of a receivable (e.g. marketplace payout) into a cash account, optionally minus a payout fee. */
  async settleReceivable(
    input: CommandMeta & { receivable: AccountKey; to: AccountKey; amountChf: Rappen; feeChf?: Rappen; feeKind?: FeeKind },
  ): Promise<AppendResult> {
    const fee = input.feeChf ?? ZERO_CHF;
    requirePositive(input.amountChf, 'settlement amount');
    requireNonNegative(fee, 'settlement fee');
    requireKind(input.receivable, ['receivable'], 'receivable');
    requireKind(input.to, ['cash'], 'settlement target');
    return this.submit('settleReceivable', input, input, (meta) =>
      this.draft('transfer', meta, 'Receivable settlement', [
        { account: input.to, amount: subChf(input.amountChf, fee) },
        { account: accounts.fee(input.feeKind ?? 'payment'), amount: fee },
        { account: input.receivable, amount: negChf(input.amountChf) },
      ]),
    );
  }

  // -------------------------------------------------------------------------
  // Reservations (earmarks, open orders, purchase commitments)
  // -------------------------------------------------------------------------

  /** Moves cash into a reservation sub-account. Net worth is unchanged; available capital drops. */
  async reserveCash(
    input: CommandMeta & { reservationId: string; from: AccountKey; amountChf: Rappen; purpose: ReservationPurpose; opportunityId?: string },
  ): Promise<AppendResult> {
    requirePositive(input.amountChf, 'reservation amount');
    requireKind(input.from, ['cash'], 'reservation source');
    const reservationAccount = accounts.reservation(input.from, input.purpose, input.reservationId);
    return this.submit('reserveCash', input, input, (meta) => (current) => {
      if (findReservation(current, input.reservationId)) {
        throw new CapitalRuleError('reservation id "' + input.reservationId + '" is already in use');
      }
      return this.draft(
        'reserve',
        meta,
        'Reserve (' + input.purpose + ')',
        [
          { account: reservationAccount, amount: input.amountChf },
          { account: input.from, amount: negChf(input.amountChf) },
        ],
        { reservationId: input.reservationId, opportunityId: input.opportunityId },
      );
    });
  }

  /** Releases a reservation back to its cash account (fully, or the given amount). */
  async releaseReservation(input: CommandMeta & { reservationId: string; amountChf?: Rappen }): Promise<AppendResult> {
    if (input.amountChf !== undefined) requirePositive(input.amountChf, 'release amount');
    return this.submit('releaseReservation', input, input, (meta) => (current) => {
      const reservation = findReservation(current, input.reservationId);
      if (!reservation) throw new CapitalRuleError('unknown reservation "' + input.reservationId + '"');
      const amount = input.amountChf ?? current.balance(reservation.key).amount;
      if (amount <= 0n) throw new CapitalRuleError('reservation "' + input.reservationId + '" has nothing left to release');
      return this.draft(
        'release_reserve',
        meta,
        'Release reservation',
        [
          { account: reservation.parent, amount },
          { account: reservation.key, amount: negChf(amount) },
        ],
        { reservationId: input.reservationId },
      );
    });
  }

  // -------------------------------------------------------------------------
  // Corrections
  // -------------------------------------------------------------------------

  /** Books the exact inverse of an entry. The original stays in the ledger (immutable history). */
  async reverse(input: { entryId: string; reason: string; id?: string; occurredAt?: string }): Promise<AppendResult> {
    if (input.reason.trim() === '') throw new CapitalRuleError('a reversal needs a reason');
    return this.submit('reverse', { id: input.id, occurredAt: input.occurredAt }, input, (meta) => (current) => {
      const original = current.get(input.entryId);
      if (!original) throw new LedgerError('unknown_entry', 'unknown entry "' + input.entryId + '"');
      return this.draft(
        'reversal',
        { ...meta, description: 'Reversal of ' + original.id + ': ' + input.reason },
        '',
        original.postings.map((p) => ({ account: p.account, amount: negChf(p.amount), ...(p.quantity ? { quantity: p.quantity.negated() } : {}) })),
        { ...original.refs, reversesEntryId: original.id },
      );
    });
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  snapshot(options: SnapshotOptions = {}): PortfolioSnapshot {
    const asOf = options.asOf ?? this.clock().toISOString();
    const balances = options.asOf === undefined ? this.ledger.balances() : this.ledger.balances({ asOf });
    return computePortfolioSnapshot(balances, this.policy, { ...options, asOf });
  }

  capitalState(options: SnapshotOptions = {}): CapitalState {
    return this.snapshot(options).capital;
  }
}

/** Fingerprint of a command and its (normalized) input. */
export function commandFingerprint(command: string, input: unknown): string {
  return hashOf({ command, input });
}

// ---------------------------------------------------------------------------
// Pure state computation
// ---------------------------------------------------------------------------

export function computePortfolioSnapshot(
  balances: ReadonlyMap<AccountKey, AccountBalance>,
  policy: CapitalPolicy,
  context: SnapshotOptions & { asOf: string },
): PortfolioSnapshot {
  const positions = derivePositions(balances, {
    asOf: context.asOf,
    maxQuoteAgeMs: policy.maxQuoteAgeMs,
    market: context.market,
    instruments: context.instruments,
  });
  const inventory = deriveInventoryHoldings(balances, context.inventoryQuotes ?? [], context.asOf, policy.maxInventoryQuoteAgeMs);

  const cash = { bank: 0n, broker: 0n, crypto: 0n, physical: 0n };
  let unreserved = 0n;
  let earmarked = 0n;
  let committed = 0n;
  let receivables = 0n;
  let liabilities = 0n;
  let contributions = 0n;
  let income = 0n;
  let expenses = 0n;

  for (const [key, { amount }] of balances) {
    const info = parseAccountKey(key);
    switch (info.kind) {
      case 'cash':
        cash[info.cashType] += amount;
        unreserved += amount;
        break;
      case 'cash_reservation':
        cash[info.cashType] += amount;
        if (info.purpose === 'earmark') earmarked += amount;
        else committed += amount;
        break;
      case 'receivable':
        receivables += amount;
        break;
      case 'payable':
      case 'tax_payable':
        liabilities -= amount;
        break;
      case 'contributions':
        contributions -= amount;
        break;
      case 'trading_pnl':
      case 'sales_revenue':
      case 'other_income':
        income -= amount;
        break;
      case 'cogs':
      case 'expense':
        expenses += amount;
        break;
      case 'position':
      case 'inventory':
        break; // valued through positions / inventory views
    }
  }

  const totalCash = rappen(cash.bank + cash.broker + cash.crypto + cash.physical);
  const financialAssets = sumChf(positions.map((p) => p.carryingValueChf));
  const financialCost = sumChf(positions.map((p) => p.costBasisChf));
  const inventoryCost = sumChf(inventory.map((i) => i.costBasisChf));
  const netWorth = rappen(totalCash + financialAssets + inventoryCost + receivables - liabilities);

  const safetyReserve = maxChf(policy.safetyReserve.minimumChf, applyBp(nonNegativeChf(netWorth), policy.safetyReserve.percentOfNetWorthBp, 'ceil'));
  const rawAvailable = rappen(unreserved - liabilities - safetyReserve);
  const invested = rappen(financialAssets + inventoryCost);

  const openPositions = positions.filter((p) => p.isOpen);
  const unpriced = openPositions.filter((p) => p.priceStatus === 'not_connected');
  const stale = openPositions.filter((p) => p.priceStatus === 'stale');
  const pricedCount = openPositions.length - unpriced.length - stale.length;
  const totalPnl = rappen(netWorth - contributions);

  const stockedProducts = inventory.filter((i) => !i.quantityOnHand.isZero());
  const inventoryPriced = stockedProducts.filter((i) => i.marketValueChf !== null);

  const capital: CapitalState = {
    timestamp: context.asOf,
    baseCurrency: BASE_CURRENCY,
    totalNetWorthChf: netWorth,
    cash: {
      bankChf: rappen(cash.bank),
      brokerCashChf: rappen(cash.broker),
      cryptoCashChf: rappen(cash.crypto),
      physicalCashChf: rappen(cash.physical),
      totalChf: totalCash,
      unreservedChf: rappen(unreserved),
    },
    reservedCapitalChf: rappen(earmarked),
    committedCapitalChf: rappen(committed),
    safetyReserveChf: safetyReserve,
    availableCapitalChf: nonNegativeChf(rawAvailable),
    capitalShortfallChf: nonNegativeChf(negChf(rawAvailable)),
    financialAssetsChf: financialAssets,
    financialAssetsCostChf: financialCost,
    physicalInventoryCostChf: inventoryCost,
    physicalInventoryMarketValueChf:
      stockedProducts.length > 0 && inventoryPriced.length === stockedProducts.length ? sumChf(inventoryPriced.map((i) => i.marketValueChf ?? ZERO_CHF)) : null,
    receivablesChf: rappen(receivables),
    liabilitiesChf: rappen(liabilities),
    investedCapitalChf: invested,
    boundCapitalChf: rappen(invested + earmarked + committed),
    netContributionsChf: rappen(contributions),
    pnl: {
      realizedChf: rappen(income - expenses),
      unrealizedChf: pricedCount === openPositions.length ? sumChf(openPositions.map((p) => p.unrealizedPnlChf ?? ZERO_CHF)) : null,
      totalChf: totalPnl,
      returnSinceStartBp: contributions > 0n ? ratioBp(totalPnl, rappen(contributions)) : null,
    },
    dataStatus: {
      financialMarketData: coverage(openPositions.length, pricedCount),
      inventoryMarketData: coverage(stockedProducts.length, inventoryPriced.length),
      unpricedPositions: unpriced.map((p) => positionKey(p.brokerId, p.instrumentId)),
      stalePositions: stale.map((p) => positionKey(p.brokerId, p.instrumentId)),
    },
  };

  return { capital, positions, inventory };
}

function coverage(required: number, available: number): CoverageStatus {
  if (required === 0) return 'not_required';
  if (available === required) return 'complete';
  return available === 0 ? 'not_connected' : 'partial';
}

// ---------------------------------------------------------------------------
// Rules & helpers
// ---------------------------------------------------------------------------

/**
 * Business rules, checked on the accounts an entry touches, against the balances after the entry.
 * Only touched accounts: a fact imported from a broker statement (e.g. a margin debit) must not block unrelated bookings.
 */
export function enforceCapitalRules(draft: JournalEntryDraft, after: LedgerView): void {
  const touched = new Set(draft.postings.map((p) => p.account));
  for (const key of touched) {
    const info = parseAccountKey(key);
    const { amount, quantity } = after.balance(key);
    if ((isCashLike(info) || info.kind === 'receivable') && amount < 0n) {
      throw new CapitalRuleError('insufficient funds: ' + key + ' would be ' + amount + ' Rappen');
    }
    if (info.kind === 'position' || info.kind === 'inventory') {
      if (quantity.isNegative()) throw new CapitalRuleError('negative quantity on ' + key + ': ' + quantity.toString());
      if (amount < 0n) throw new CapitalRuleError('negative cost basis on ' + key);
      if (quantity.isZero() && amount !== 0n) throw new CapitalRuleError('residual cost basis of ' + amount + ' Rappen on empty ' + key);
    }
    if ((info.kind === 'payable' || info.kind === 'tax_payable') && amount > 0n) {
      throw new CapitalRuleError('liability overpaid: ' + key);
    }
  }
}

/** Average-cost release; selling everything releases exactly the remaining cost (no rounding residue). */
export function releasedCost(holding: AccountBalance, quantity: Decimal): Rappen {
  if (quantity.eq(holding.quantity)) return holding.amount;
  return prorateChf(holding.amount, quantity, holding.quantity, 'half_even');
}

export function findReservation(view: LedgerView, reservationId: string): { key: AccountKey; parent: AccountKey } | undefined {
  for (const key of view.balances().keys()) {
    const info = parseAccountKey(key);
    if (info.kind === 'cash_reservation' && info.reservationId === reservationId) return { key, parent: info.parent };
  }
  return undefined;
}

function tradeRefs(input: { brokerId: string; instrumentId: string; tradeId?: string; opportunityId?: string }): EntryRefs {
  return { brokerId: input.brokerId, instrumentId: input.instrumentId, tradeId: input.tradeId, opportunityId: input.opportunityId };
}

export function requireKind(account: AccountKey, kinds: readonly string[], label: string): void {
  const info = parseAccountKey(account);
  if (!kinds.includes(info.kind)) throw new CapitalRuleError(label + ' must be ' + kinds.join(' or ') + ', got ' + info.kind + ' (' + account + ')');
}

export function requirePositive(amount: Rappen, label: string): void {
  if (typeof amount !== 'bigint') throw new CapitalRuleError(label + ' must be Rappen (bigint)');
  if (amount <= 0n) throw new CapitalRuleError(label + ' must be positive');
}

export function requireNonNegative(amount: Rappen, label: string): void {
  if (typeof amount !== 'bigint') throw new CapitalRuleError(label + ' must be Rappen (bigint)');
  if (amount < 0n) throw new CapitalRuleError(label + ' must not be negative');
}

export function requirePositiveQuantity(value: DecimalInput): Decimal {
  const quantity = Decimal.from(value);
  if (!quantity.isPositive()) throw new CapitalRuleError('quantity must be positive, got ' + quantity.toString());
  return quantity;
}

function validatePolicy(policy: CapitalPolicy): void {
  requireNonNegative(policy.safetyReserve.minimumChf, 'safety reserve minimum');
  const bp = policy.safetyReserve.percentOfNetWorthBp;
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) throw new CapitalRuleError('safety reserve percentage must be 0..10000 bp');
  if (!(policy.maxQuoteAgeMs > 0) || !(policy.maxInventoryQuoteAgeMs > 0)) throw new CapitalRuleError('quote age limits must be positive');
}
