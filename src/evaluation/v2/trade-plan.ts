// R2 Learning Evaluation v2: the trade plan contract. A decision can only be evaluated against a plan that was complete and
// sealed BEFORE anything about its outcome could be known. The plan fixes side, position context, entry rule, stop, target,
// holding limit, size, cost assumptions and the data it was made from; the evaluator never chooses an entry, an exit or a
// horizon after the fact. Missing information is a refusal (the plan is not evaluable), never a guessed default.

import type { BarInterval } from '../../market-data/market-data-types.js';
import { INTERVAL_MS } from '../../market-data/market-data-types.js';
import { parseUtc } from '../../market-data/time.js';
import { Decimal } from '../../money/decimal.js';
import { hashOf } from '../../persistence/canonical-json.js';

export const TRADE_PLAN_SCHEMA = 'trade-plan:v1' as const;
export const OUTCOME_EVAL_V2 = 'outcome-eval:v2' as const;
/** The v1 method (src/evaluation/outcome-evaluator.ts). Observations without a method label are v1. */
export const OUTCOME_EVAL_V1 = 'outcome-eval:v1' as const;

/**
 * Where an evaluated result comes from. The three sources are never mixed in one aggregate:
 *   historical_simulation  a backtest or replay over stored history;
 *   research               a live hypothetical decision of the research instance;
 *   demo                   a controlled eToro demo (virtual) decision.
 */
export type EvaluationOrigin = 'historical_simulation' | 'research' | 'demo';
/** What the result is: only HYPOTHETICAL is produced by the v2 simulator. PAPER, DEMO and LIVE need observed fills. */
export type Realization = 'HYPOTHETICAL' | 'PAPER' | 'DEMO' | 'LIVE';
export const REALIZATIONS: readonly Realization[] = ['HYPOTHETICAL', 'PAPER', 'DEMO', 'LIVE'];

export type TradeSide = 'long' | 'short';
/** The position the decision was made in. HOLD and EXIT need an open position; ENTER needs none. */
export type PositionContext = 'flat' | 'long_open' | 'short_open';

/**
 * How a bar in which both the stop and the target were reachable is resolved. OHLC data does not say which came first.
 *   conservative_stop_first  the stop is assumed first (documented conservative assumption; the result is flagged);
 *   indeterminate            the evaluation is INDETERMINATE (no assumption).
 */
export type IntrabarPolicy = 'conservative_stop_first' | 'indeterminate';

export interface CostAssumptions {
  /** Version of these assumptions; part of the plan hash. */
  version: string;
  /** Commission per side in basis points of the traded notional. */
  commissionBps: number;
  /** Fixed fee per side in the quote currency (decimal string). */
  fixedFeePerSide: string;
  /** Full bid/ask spread in basis points (half is paid on entry, half on exit). Modelled unless measured. */
  spreadBps: number;
  spreadSource: 'modeled' | 'measured';
  /** Adverse slippage per fill in basis points (modelled). */
  slippageBps: number;
}

export interface TradePlan {
  schema: typeof TRADE_PLAN_SCHEMA;
  planId: string;
  signalId: string;
  decisionId: string;
  instrumentId: string;
  /** Market data source the outcome is read from (e.g. twelvedata:time_series:production). */
  source: string;
  interval: BarInterval;
  side: TradeSide;
  positionContext: PositionContext;
  strategy: { id: string; version: string };
  ruleVersion: string;
  codeVersion: string;
  evaluationMethod: typeof OUTCOME_EVAL_V2;
  origin: EvaluationOrigin;
  realization: Realization;
  /** v2 enters at the open of the first bar that starts at or after earliestEntryAt (no discretionary entry). */
  entry: { method: 'next_bar_open'; earliestEntryAt: string };
  stopLoss: string;
  takeProfit?: string;
  /** Time exit: at the close of the n-th bar of the position (the entry bar counts as the first). */
  maxHoldingBars: number;
  size: { kind: 'notional'; amount: string } | { kind: 'quantity'; quantity: string };
  costs: CostAssumptions;
  intrabarPolicy: IntrabarPolicy;
  /** The information the plan was made from: its point in time and the reproducibility anchors. */
  dataBasis: { asOf: string; storedThrough: number; inputFingerprint: string };
}

export class TradePlanError extends Error {
  override readonly name = 'TradePlanError';
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9:_.+-]{0,63}$/;
const DECIMAL = /^\d{1,15}(\.\d{1,12})?$/;
const MAX_BPS = 2_000;
const MAX_HOLDING_BARS = 10_000;

function problem(problems: string[], ok: boolean, message: string): void {
  if (!ok) problems.push(message);
}

function isInstant(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    parseUtc(value);
    return true;
  } catch {
    return false;
  }
}

function positive(value: unknown): boolean {
  return typeof value === 'string' && DECIMAL.test(value) && !Decimal.from(value).isZero();
}

function bps(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BPS;
}

/**
 * Every reason the plan is not complete or not consistent (empty: valid). Checked: all identities and versions, side and
 * position context, the stop on the loss side and the target on the profit side of the reference price, holding limit, size,
 * costs, intrabar policy and data basis.
 */
export function tradePlanProblems(plan: Partial<TradePlan>, referencePrice?: string): string[] {
  const p: string[] = [];
  problem(p, plan.schema === TRADE_PLAN_SCHEMA, 'schema must be ' + TRADE_PLAN_SCHEMA);
  for (const field of ['planId', 'signalId', 'decisionId', 'instrumentId', 'source'] as const) problem(p, typeof plan[field] === 'string' && ID.test(plan[field] as string), field + ' is missing or malformed');
  problem(p, plan.interval !== undefined && plan.interval !== '1d' && plan.interval in INTERVAL_MS, 'interval must be an intraday interval');
  problem(p, plan.side === 'long' || plan.side === 'short', 'side must be long or short');
  problem(p, plan.positionContext === 'flat' || plan.positionContext === 'long_open' || plan.positionContext === 'short_open', 'positionContext is missing');
  problem(p, typeof plan.strategy?.id === 'string' && ID.test(plan.strategy.id) && typeof plan.strategy.version === 'string' && VERSION.test(plan.strategy.version), 'strategy id and version are required');
  problem(p, typeof plan.ruleVersion === 'string' && VERSION.test(plan.ruleVersion), 'ruleVersion is required');
  problem(p, typeof plan.codeVersion === 'string' && VERSION.test(plan.codeVersion), 'codeVersion is required');
  problem(p, plan.evaluationMethod === OUTCOME_EVAL_V2, 'evaluationMethod must be ' + OUTCOME_EVAL_V2);
  problem(p, plan.origin === 'historical_simulation' || plan.origin === 'research' || plan.origin === 'demo', 'origin is missing');
  problem(p, plan.realization !== undefined && REALIZATIONS.includes(plan.realization), 'realization is missing');
  problem(p, plan.entry?.method === 'next_bar_open' && isInstant(plan.entry.earliestEntryAt), 'entry must be next_bar_open with an earliestEntryAt instant');
  problem(p, positive(plan.stopLoss), 'stopLoss is required (a positive price)');
  problem(p, plan.takeProfit === undefined || positive(plan.takeProfit), 'takeProfit must be a positive price when given');
  problem(p, Number.isInteger(plan.maxHoldingBars) && plan.maxHoldingBars! >= 1 && plan.maxHoldingBars! <= MAX_HOLDING_BARS, 'maxHoldingBars must be an integer from 1 to ' + MAX_HOLDING_BARS);
  const size = plan.size;
  problem(p, size !== undefined && ((size.kind === 'notional' && positive(size.amount)) || (size.kind === 'quantity' && positive(size.quantity))), 'size is required (positive notional or quantity)');
  const c = plan.costs;
  problem(
    p,
    c !== undefined && typeof c.version === 'string' && VERSION.test(c.version) && bps(c.commissionBps) && typeof c.fixedFeePerSide === 'string' && (c.fixedFeePerSide === '0' || DECIMAL.test(c.fixedFeePerSide)) && bps(c.spreadBps) && (c.spreadSource === 'modeled' || c.spreadSource === 'measured') && bps(c.slippageBps),
    'costs are required (version, commission, fixed fee, spread with its source, slippage)',
  );
  problem(p, plan.intrabarPolicy === 'conservative_stop_first' || plan.intrabarPolicy === 'indeterminate', 'intrabarPolicy is required');
  problem(p, plan.dataBasis !== undefined && isInstant(plan.dataBasis.asOf) && Number.isInteger(plan.dataBasis.storedThrough) && plan.dataBasis.storedThrough >= 0 && /^[0-9a-f]{64}$/.test(plan.dataBasis.inputFingerprint ?? ''), 'dataBasis (asOf, storedThrough, inputFingerprint) is required');
  if (p.length === 0 && plan.dataBasis && plan.entry && parseUtc(plan.dataBasis.asOf) > parseUtc(plan.entry.earliestEntryAt)) p.push('dataBasis.asOf lies after the earliest entry');
  // HOLD and EXIT plans continue an open position of the plan's side; an entry plan starts flat.
  if (p.length === 0 && plan.positionContext !== 'flat' && plan.positionContext !== plan.side + '_open') p.push('an open-position plan must continue the open side (' + plan.positionContext + ' vs ' + plan.side + ')');
  if (p.length === 0 && referencePrice !== undefined) {
    const ref = Decimal.from(referencePrice);
    const stop = Decimal.from(plan.stopLoss!);
    if (plan.side === 'long' ? !stop.lt(ref) : !stop.gt(ref)) p.push('stopLoss must lie on the loss side of the reference price');
    if (plan.takeProfit !== undefined) {
      const tp = Decimal.from(plan.takeProfit);
      if (plan.side === 'long' ? !tp.gt(ref) : !tp.lt(ref)) p.push('takeProfit must lie on the profit side of the reference price');
    }
  }
  return p;
}

/** The identity of a plan: SHA-256 over its canonical form. */
export function tradePlanHash(plan: TradePlan): string {
  return hashOf(plan);
}
