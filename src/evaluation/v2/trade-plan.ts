// R2 Learning Evaluation v2: the plan contracts. A decision can only be evaluated against a plan that was complete before its
// outcome could be known. Two kinds:
//   trade-plan:v2         an ENTRY plan (ENTER_LONG, ENTER_SHORT, and the rejected candidate of NO_TRADE): from flat, enter at the
//                         next bar open with a stop, an optional target, a holding limit, a size and cost assumptions;
//   continuation-plan:v1  an OPEN position at a decision point (HOLD, EXIT): the real remaining position (side, quantity, entry,
//                         costs already paid, current stop and target) and how it would be managed if held. It never opens a
//                         position; its value is "hold" against "close now" from the same decision bar.
// The evaluator never chooses an entry, an exit or a horizon after the fact. Missing information is a refusal, never a default.
// trade-plan:v1 (R2 before review) is superseded: its HOLD/EXIT semantics simulated a new entry. v1 plans are not evaluated.

import type { BarInterval } from '../../market-data/market-data-types.js';
import { INTERVAL_MS } from '../../market-data/market-data-types.js';
import { parseUtc } from '../../market-data/time.js';
import { Decimal } from '../../money/decimal.js';
import { hashOf } from '../../persistence/canonical-json.js';

export const TRADE_PLAN_SCHEMA = 'trade-plan:v2' as const;
export const CONTINUATION_PLAN_SCHEMA = 'continuation-plan:v1' as const;
/** The superseded entry plan schema (simulated a new entry for HOLD and EXIT). Never evaluated. */
export const SUPERSEDED_PLAN_SCHEMAS: readonly string[] = Object.freeze(['trade-plan:v1']);
export const OUTCOME_EVAL_V2 = 'outcome-eval:v2' as const;
/** The v1 method (src/evaluation/outcome-evaluator.ts). Observations without a method label are v1. */
export const OUTCOME_EVAL_V1 = 'outcome-eval:v1' as const;

/**
 * Where a plan comes from. The three are never mixed in one aggregate:
 *   historical_simulation  made now about the past (backtest, replay): a reconstruction, never a decision of that time;
 *   research               a live hypothetical decision of the research instance, sealed before its entry;
 *   demo                   a controlled eToro demo (virtual) decision.
 */
export type EvaluationOrigin = 'historical_simulation' | 'research' | 'demo';
/** What the result is: only HYPOTHETICAL is produced by the v2 simulator. PAPER, DEMO and LIVE need observed fills. */
export type Realization = 'HYPOTHETICAL' | 'PAPER' | 'DEMO' | 'LIVE';
export const REALIZATIONS: readonly Realization[] = ['HYPOTHETICAL', 'PAPER', 'DEMO', 'LIVE'];

export type TradeSide = 'long' | 'short';
/** The position the decision was made in. HOLD and EXIT need an open position; ENTER and NO_TRADE need none. */
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
  /** Fixed fee per side, in feeCurrency. */
  fixedFeePerSide: string;
  /** Must equal the plan's quote currency: R2 converts no currency. */
  feeCurrency: string;
  /** Full bid/ask spread in basis points (half is paid on each fill). Modelled unless measured. */
  spreadBps: number;
  spreadSource: 'modeled' | 'measured';
  /** Adverse slippage per fill in basis points (modelled). */
  slippageBps: number;
}

/** Fields both plan kinds share. */
interface PlanCommon {
  planId: string;
  signalId: string;
  decisionId: string;
  instrumentId: string;
  /** Market data source the outcome is read from (e.g. twelvedata:time_series:production). */
  source: string;
  interval: BarInterval;
  /** ISO currency of prices, PnL and fees (the instrument's quote currency). */
  quoteCurrency: string;
  strategy: { id: string; version: string };
  ruleVersion: string;
  codeVersion: string;
  evaluationMethod: typeof OUTCOME_EVAL_V2;
  origin: EvaluationOrigin;
  realization: Realization;
  stopLoss: string;
  takeProfit?: string;
  /** Exit at the close of the n-th bar from the plan's first bar (that bar counts as the first). */
  maxHoldingBars: number;
  costs: CostAssumptions;
  intrabarPolicy: IntrabarPolicy;
  /** The information the plan was made from: its point in time and the reproducibility anchors. */
  dataBasis: { asOf: string; storedThrough: number; inputFingerprint: string };
}

export interface TradePlan extends PlanCommon {
  schema: typeof TRADE_PLAN_SCHEMA;
  side: TradeSide;
  /** An entry plan always starts flat. */
  positionContext: 'flat';
  /** v2 enters at the open of the first bar that starts at or after earliestEntryAt (no discretionary entry). */
  entry: { method: 'next_bar_open'; earliestEntryAt: string };
  size: { kind: 'notional'; amount: string } | { kind: 'quantity'; quantity: string };
}

/** The real remaining position at the decision point. Without it a HOLD or EXIT is not evaluable. */
export interface OpenPositionState {
  positionRef: string;
  side: TradeSide;
  /** The quantity still open (after any earlier partial exits). */
  quantity: string;
  /** Average entry price of the open quantity (informational: it is a sunk price, not part of hold-versus-close). */
  entryPrice: string;
  openedAt: string;
  /** Costs already paid for this position (informational, never charged again). */
  costsAlreadyPaid: string;
}

export interface ContinuationPlan extends PlanCommon {
  schema: typeof CONTINUATION_PLAN_SCHEMA;
  positionContext: 'long_open' | 'short_open';
  position: OpenPositionState;
  /** Both alternatives (close now, hold) start at the open of the first bar at or after this instant. */
  decisionAt: string;
}

export type AnyPlan = TradePlan | ContinuationPlan;

export class TradePlanError extends Error {
  override readonly name = 'TradePlanError';
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9:_.+-]{0,63}$/;
const DECIMAL = /^\d{1,15}(\.\d{1,12})?$/;
const CURRENCY = /^[A-Z]{3}$/;
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

function nonNegative(value: unknown): boolean {
  return typeof value === 'string' && (value === '0' || DECIMAL.test(value));
}

function bps(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BPS;
}

/** The plan's first instant: the earliest entry (entry plan) or the decision point (continuation plan). */
export function planStartOf(plan: AnyPlan): string {
  return plan.schema === CONTINUATION_PLAN_SCHEMA ? plan.decisionAt : plan.entry.earliestEntryAt;
}

/** The side of the position the plan holds. */
export function planSideOf(plan: AnyPlan): TradeSide {
  return plan.schema === CONTINUATION_PLAN_SCHEMA ? plan.position.side : plan.side;
}

function commonProblems(plan: Partial<PlanCommon>, p: string[]): void {
  for (const field of ['planId', 'signalId', 'decisionId', 'instrumentId', 'source'] as const) problem(p, typeof plan[field] === 'string' && ID.test(plan[field] as string), field + ' is missing or malformed');
  problem(p, plan.interval !== undefined && plan.interval !== '1d' && plan.interval in INTERVAL_MS, 'interval must be an intraday interval');
  problem(p, typeof plan.quoteCurrency === 'string' && CURRENCY.test(plan.quoteCurrency), 'quoteCurrency is required (ISO code)');
  problem(p, typeof plan.strategy?.id === 'string' && ID.test(plan.strategy.id) && typeof plan.strategy.version === 'string' && VERSION.test(plan.strategy.version), 'strategy id and version are required');
  problem(p, typeof plan.ruleVersion === 'string' && VERSION.test(plan.ruleVersion), 'ruleVersion is required');
  problem(p, typeof plan.codeVersion === 'string' && VERSION.test(plan.codeVersion), 'codeVersion is required');
  problem(p, plan.evaluationMethod === OUTCOME_EVAL_V2, 'evaluationMethod must be ' + OUTCOME_EVAL_V2);
  problem(p, plan.origin === 'historical_simulation' || plan.origin === 'research' || plan.origin === 'demo', 'origin is missing');
  problem(p, plan.realization !== undefined && REALIZATIONS.includes(plan.realization), 'realization is missing');
  problem(p, positive(plan.stopLoss), 'stopLoss is required (a positive price)');
  problem(p, plan.takeProfit === undefined || positive(plan.takeProfit), 'takeProfit must be a positive price when given');
  problem(p, Number.isInteger(plan.maxHoldingBars) && plan.maxHoldingBars! >= 1 && plan.maxHoldingBars! <= MAX_HOLDING_BARS, 'maxHoldingBars must be an integer from 1 to ' + MAX_HOLDING_BARS);
  const c = plan.costs;
  problem(
    p,
    c !== undefined && typeof c.version === 'string' && VERSION.test(c.version) && bps(c.commissionBps) && nonNegative(c.fixedFeePerSide) && typeof c.feeCurrency === 'string' && CURRENCY.test(c.feeCurrency) && bps(c.spreadBps) && (c.spreadSource === 'modeled' || c.spreadSource === 'measured') && bps(c.slippageBps),
    'costs are required (version, commission, fixed fee and its currency, spread with its source, slippage)',
  );
  if (c !== undefined && typeof c.feeCurrency === 'string' && typeof plan.quoteCurrency === 'string' && c.feeCurrency !== plan.quoteCurrency) p.push('fee currency ' + c.feeCurrency + ' differs from the quote currency ' + plan.quoteCurrency + ' (R2 converts no currency)');
  problem(p, plan.intrabarPolicy === 'conservative_stop_first' || plan.intrabarPolicy === 'indeterminate', 'intrabarPolicy is required');
  problem(p, plan.dataBasis !== undefined && isInstant(plan.dataBasis.asOf) && Number.isInteger(plan.dataBasis.storedThrough) && plan.dataBasis.storedThrough >= 0 && /^[0-9a-f]{64}$/.test(plan.dataBasis.inputFingerprint ?? ''), 'dataBasis (asOf, storedThrough, inputFingerprint) is required');
}

function priceSideProblems(side: TradeSide, stopLoss: string, takeProfit: string | undefined, referencePrice: string, p: string[]): void {
  const ref = Decimal.from(referencePrice);
  const stop = Decimal.from(stopLoss);
  if (side === 'long' ? !stop.lt(ref) : !stop.gt(ref)) p.push('stopLoss must lie on the loss side of the reference price');
  if (takeProfit !== undefined) {
    const tp = Decimal.from(takeProfit);
    if (side === 'long' ? !tp.gt(ref) : !tp.lt(ref)) p.push('takeProfit must lie on the profit side of the reference price');
  }
}

/** Every reason the plan is not complete or not consistent (empty: valid). `referencePrice` checks stop and target sides. */
export function tradePlanProblems(plan: Partial<AnyPlan> & { schema?: string }, referencePrice?: string): string[] {
  const p: string[] = [];
  if (plan.schema !== undefined && SUPERSEDED_PLAN_SCHEMAS.includes(plan.schema)) return ['plan schema ' + plan.schema + ' is superseded'];
  if (plan.schema === CONTINUATION_PLAN_SCHEMA) {
    const c = plan as Partial<ContinuationPlan>;
    commonProblems(c, p);
    const pos = c.position;
    problem(
      p,
      pos !== undefined && typeof pos.positionRef === 'string' && ID.test(pos.positionRef) && (pos.side === 'long' || pos.side === 'short') && positive(pos.quantity) && positive(pos.entryPrice) && isInstant(pos.openedAt) && nonNegative(pos.costsAlreadyPaid),
      'position is required (ref, side, open quantity, entry price, opened at, costs already paid)',
    );
    problem(p, c.positionContext === 'long_open' || c.positionContext === 'short_open', 'positionContext must be long_open or short_open');
    problem(p, isInstant(c.decisionAt), 'decisionAt is required');
    if (p.length === 0 && c.positionContext !== c.position!.side + '_open') p.push('positionContext ' + c.positionContext + ' does not match the open ' + c.position!.side + ' position');
    if (p.length === 0 && parseUtc(c.position!.openedAt) > parseUtc(c.decisionAt!)) p.push('the position was opened after the decision point');
    if (p.length === 0 && parseUtc(c.dataBasis!.asOf) > parseUtc(c.decisionAt!)) p.push('dataBasis.asOf lies after the decision point');
    if (p.length === 0 && referencePrice !== undefined) priceSideProblems(c.position!.side, c.stopLoss!, c.takeProfit, referencePrice, p);
    return p;
  }
  problem(p, plan.schema === TRADE_PLAN_SCHEMA, 'schema must be ' + TRADE_PLAN_SCHEMA + ' or ' + CONTINUATION_PLAN_SCHEMA);
  const t = plan as Partial<TradePlan>;
  commonProblems(t, p);
  problem(p, t.side === 'long' || t.side === 'short', 'side must be long or short');
  problem(p, t.positionContext === 'flat', 'an entry plan starts flat (an open position needs a continuation plan)');
  problem(p, t.entry?.method === 'next_bar_open' && isInstant(t.entry.earliestEntryAt), 'entry must be next_bar_open with an earliestEntryAt instant');
  const size = t.size;
  problem(p, size !== undefined && ((size.kind === 'notional' && positive(size.amount)) || (size.kind === 'quantity' && positive(size.quantity))), 'size is required (positive notional or quantity)');
  if (p.length === 0 && parseUtc(t.dataBasis!.asOf) > parseUtc(t.entry!.earliestEntryAt)) p.push('dataBasis.asOf lies after the earliest entry');
  if (p.length === 0 && referencePrice !== undefined) priceSideProblems(t.side!, t.stopLoss!, t.takeProfit, referencePrice, p);
  return p;
}

/** The identity of a plan: SHA-256 over its canonical form. */
export function tradePlanHash(plan: AnyPlan): string {
  return hashOf(plan);
}
