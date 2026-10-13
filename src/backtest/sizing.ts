import { Decimal } from '../money/decimal.js';
import type { DeterministicCostModel } from './cost-model.js';
import type { EntryRiskSizingAudit, PositionSizing } from './backtest-types.js';

/**
 * The risk sizing version. It is recorded on every risk-sized entry and enters the input fingerprint (docs/O5_EXECUTABLE_RISK_SIZING_V1.md §15).
 */
export const RISK_SIZING_VERSION = 'risk-sizing:v1' as const;

/** The quantity scale: 12 decimals, always rounded DOWN. */
const QUANTITY_SCALE = 12;

function basisPointsFraction(bp: number): Decimal {
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) throw new Error('basis points must be an integer between 0 and 10000');
  return Decimal.from(bp).dividedBy(10_000, QUANTITY_SCALE, 'half_even');
}

function minDecimal(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

/** The three basis-point values of a risk-sized run, as validated. */
export interface RiskPerTradeConfig {
  readonly riskBasisPoints: number;
  readonly maxCashBasisPoints: number;
  readonly stopGapStressBasisPoints: number;
}

/**
 * Validates the risk_per_trade configuration. Each value must be a safe integer (so no NaN, no Infinity and no fraction). The stop gap stress is required:
 * there is no default and no market-derived value. Throws before any run starts.
 */
export function riskPerTradeConfigOf(sizing: Extract<PositionSizing, { type: 'risk_per_trade' }>): RiskPerTradeConfig {
  const within = (value: unknown, name: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(name + ' must be an integer from ' + min + ' to ' + max + ' basis points');
    }
    return value;
  };
  return {
    riskBasisPoints: within(sizing.riskBasisPoints, 'riskBasisPoints', 1, 10_000),
    maxCashBasisPoints: within(sizing.maxCashBasisPoints, 'maxCashBasisPoints', 1, 10_000),
    stopGapStressBasisPoints: within(sizing.stopGapStressBasisPoints, 'stopGapStressBasisPoints', 0, 9_999),
  };
}

export interface RiskSizingInput {
  readonly costModel: DeterministicCostModel;
  /** The raw entry price: bar.open of the executable-open bar. */
  readonly rawEntryPrice: Decimal;
  /** The stop after any corporate-action transformation due at the open. Null when the strategy gave none. */
  readonly stopLoss: Decimal | null;
  readonly config: RiskPerTradeConfig;
  /** The equity the risk budget is taken from (spendable cash at the entry event). */
  readonly sizingEquity: Decimal;
  readonly spendableCash: Decimal;
}

export type RiskSizingRefusal = 'STOP_MISSING' | 'STOP_NOT_POSITIVE' | 'STOP_NOT_BELOW_ENTRY' | 'STRESS_EXIT_NOT_POSITIVE' | 'NO_AFFORDABLE_QUANTITY';

/**
 * The one calculation of a risk-sized entry (risk-sizing:v1, docs/O5_EXECUTABLE_RISK_SIZING_V1.md §4–§7). The quantity and its audit record come from the same
 * values, and nothing is recomputed elsewhere. Exact Decimal arithmetic throughout.
 *
 * The modeled stress downside is D(Q) = Q(P − Ps) + max(cP·Q, m) + max(cPs·Q, m), where P is the buy execution price, Ps the stressed sell execution price, c the
 * commission rate and m the minimum commission. D is the maximum of four linear functions, so D(Q) ≤ R exactly when all four hold. That gives four bounds,
 * and the quantity is the minimum of them, rounded down. The cash cap is DeterministicCostModel.maxAffordableQuantity, which is exact for the same reason.
 */
export function maxRiskSizedLongQuantity(input: RiskSizingInput): { quantity: Decimal; audit: EntryRiskSizingAudit; refusal: null } | { quantity: Decimal; audit: null; refusal: RiskSizingRefusal } {
  const refuse = (refusal: RiskSizingRefusal) => ({ quantity: Decimal.ZERO, audit: null, refusal });
  const { stopLoss, rawEntryPrice: raw, config } = input;
  if (stopLoss === null) return refuse('STOP_MISSING');
  if (!stopLoss.isPositive()) return refuse('STOP_NOT_POSITIVE');
  // The stop is a raw market level: it must lie strictly below the raw entry, not merely below the buy execution price.
  if (!stopLoss.lt(raw)) return refuse('STOP_NOT_BELOW_ENTRY');

  const costs = input.costModel.config;
  const stressFactor = Decimal.from(10_000 - config.stopGapStressBasisPoints).dividedBy(10_000, QUANTITY_SCALE, 'half_even');
  const stressRawExitPrice = stopLoss.times(stressFactor);
  if (!stressRawExitPrice.isPositive()) return refuse('STRESS_EXIT_NOT_POSITIVE');

  const entryExecutionPrice = input.costModel.executionPrice(raw, 'buy');
  const stressExecutionPrice = input.costModel.executionPrice(stressRawExitPrice, 'sell');
  // a = per-unit price drop from the buy execution to the stressed sell execution. Positive whenever the stop is below the raw entry.
  const a = entryExecutionPrice.minus(stressExecutionPrice);
  const c = Decimal.from(costs.commissionBps).dividedBy(10_000, QUANTITY_SCALE, 'half_even');
  const m = Decimal.from(costs.minCommission);
  const alpha = entryExecutionPrice.times(c);
  const beta = stressExecutionPrice.times(c);

  const riskBudget = input.sizingEquity.times(basisPointsFraction(config.riskBasisPoints));
  const cashBudget = minDecimal(input.spendableCash, input.sizingEquity.times(basisPointsFraction(config.maxCashBasisPoints)));

  // Each bound is R − k·m over a positive denominator. A non-positive numerator allows nothing; the bounds are floored, so their minimum is the floor of the minimum.
  const bound = (numerator: Decimal, denominator: Decimal): Decimal => (numerator.isPositive() ? numerator.dividedBy(denominator, QUANTITY_SCALE, 'down') : Decimal.ZERO);
  const riskLimitedQuantity = minDecimal(
    minDecimal(bound(riskBudget, a.plus(alpha).plus(beta)), bound(riskBudget.minus(m), a.plus(alpha))),
    minDecimal(bound(riskBudget.minus(m), a.plus(beta)), bound(riskBudget.minus(m.times(2)), a)),
  );
  const cashLimitedQuantity = input.costModel.maxAffordableQuantity(cashBudget, raw, QUANTITY_SCALE);
  const quantity = minDecimal(riskLimitedQuantity, cashLimitedQuantity);
  if (!quantity.isPositive()) return refuse('NO_AFFORDABLE_QUANTITY');

  const bindingConstraint: EntryRiskSizingAudit['bindingConstraint'] = riskLimitedQuantity.lt(cashLimitedQuantity)
    ? 'risk_budget'
    : cashLimitedQuantity.lt(riskLimitedQuantity)
      ? 'cash_budget'
      : 'both';

  const entryNotional = entryExecutionPrice.times(quantity);
  const entryCommission = input.costModel.commission(entryNotional);
  const stressNotional = stressExecutionPrice.times(quantity);
  const stressExitCommission = input.costModel.commission(stressNotional);
  const modeledStressDownside = entryNotional.plus(entryCommission).minus(stressNotional.minus(stressExitCommission));

  // Defensive: the derivation guarantees both, and an exact check makes a violation impossible to ship silently.
  if (modeledStressDownside.gt(riskBudget) || entryNotional.plus(entryCommission).gt(cashBudget)) {
    throw new Error('risk sizing invariant violated: the chosen quantity exceeds its budget');
  }

  const audit: EntryRiskSizingAudit = {
    version: RISK_SIZING_VERSION,
    riskBasisPoints: config.riskBasisPoints,
    maxCashBasisPoints: config.maxCashBasisPoints,
    stopGapStressBasisPoints: config.stopGapStressBasisPoints,
    sizingEquity: input.sizingEquity,
    spendableCash: input.spendableCash,
    riskBudget,
    cashBudget,
    rawEntryPrice: raw,
    entryExecutionPrice,
    stopLoss,
    stressRawExitPrice,
    stressExecutionPrice,
    quantity,
    entryCommission,
    stressExitCommission,
    modeledStressDownside,
    riskLimitedQuantity,
    cashLimitedQuantity,
    bindingConstraint,
  };
  return { quantity, audit, refusal: null };
}

/**
 * Sizing for fixed_cash and percent_equity. risk_per_trade is not sized here: it has its own audited path (maxRiskSizedLongQuantity).
 */
export function desiredLongQuantity(input: {
  sizing: PositionSizing;
  cash: Decimal;
  equity: Decimal;
  executionPrice: Decimal;
}): Decimal {
  if (!input.executionPrice.isPositive() || !input.cash.isPositive()) return Decimal.ZERO;

  switch (input.sizing.type) {
    case 'fixed_cash': {
      const budget = minDecimal(input.cash, Decimal.from(input.sizing.amount));
      if (!budget.isPositive()) return Decimal.ZERO;
      return budget.dividedBy(input.executionPrice, QUANTITY_SCALE, 'down');
    }
    case 'percent_equity': {
      const budget = minDecimal(input.cash, input.equity.times(basisPointsFraction(input.sizing.basisPoints)));
      if (!budget.isPositive()) return Decimal.ZERO;
      return budget.dividedBy(input.executionPrice, QUANTITY_SCALE, 'down');
    }
    case 'risk_per_trade':
      throw new Error('risk_per_trade is sized by maxRiskSizedLongQuantity, never by desiredLongQuantity');
  }
}
