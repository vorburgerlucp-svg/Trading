// R2 Learning Evaluation v2 (outcome-eval:v2, policy v2.1). Evaluates one decision against the plan it was made with.
// v1 (src/evaluation/outcome-evaluator.ts) stays unchanged for old records and reviews.
//
// What is evaluated against what:
//   ENTER_LONG / ENTER_SHORT  flat   entry plan (trade-plan:v2) of that side      value = its net R
//   NO_TRADE                  flat   the rejected candidate entry plan             value = minus its net R; without a plan: not evaluable
//   HOLD                      open   continuation plan (continuation-plan:v1)      value = hold versus close now, in R of the risk kept
//   EXIT                      open   continuation plan                             value = close now versus hold (minus the HOLD value)
//   NO_ACTION, INSUFFICIENT_DATA     no judgement: never scored, only counted
// HOLD and EXIT never simulate a new entry: both alternatives start at the same decision bar with the same fill model, and the
// costs already paid are sunk. Without the real open position (quantity, side, current stop) a HOLD or EXIT is not evaluable.
// A partial exit is not modelled in R2 and is not evaluable.
//
// Authenticity of the seal (who says the plan existed before its outcome?):
//   unverified                 the plan was handed in by the caller (tests, synthetic scenarios): evaluated, but it is a claim
//   sealed_before_outcome      read from the TradePlanLedger, stored strictly before the plan's first bar (research, demo)
//   historical_reconstruction  read from the ledger, made NOW about the past (historical simulation): never a decision of that time
// Only a ledger-read plan can become a performance observation (performance-v2.ts).
//
// policy v2.0 (before review) simulated a new entry for HOLD and EXIT and required a wall-clock seal for backtests; results under
// v2.0 are never mixed with v2.1 (the policy version is part of the record id and of every aggregate's scope).

import type { MarketBar } from '../../market-data/market-data-types.js';
import type { TradingCalendar } from '../../market-data/sessions.js';
import { parseUtc } from '../../market-data/time.js';
import { Decimal } from '../../money/decimal.js';
import { TradePlanLedger, type SealedPlan } from './plan-ledger.js';
import { simulateContinuation, simulateTradePlan, type PlanSimulation, type SimulationOptions } from './plan-simulator.js';
import {
  CONTINUATION_PLAN_SCHEMA,
  OUTCOME_EVAL_V2,
  planSideOf,
  planStartOf,
  SUPERSEDED_PLAN_SCHEMAS,
  TRADE_PLAN_SCHEMA,
  tradePlanHash,
  tradePlanProblems,
  type EvaluationOrigin,
  type PositionContext,
  type Realization,
} from './trade-plan.js';

export const OUTCOME_EVAL_V2_POLICY_VERSION = 'outcome-eval-policy:v2.1' as const;

export type DecisionActionV2 = 'ENTER_LONG' | 'ENTER_SHORT' | 'EXIT' | 'HOLD' | 'NO_TRADE' | 'NO_ACTION' | 'INSUFFICIENT_DATA';
export const DECISION_ACTIONS_V2: readonly DecisionActionV2[] = ['ENTER_LONG', 'ENTER_SHORT', 'EXIT', 'HOLD', 'NO_TRADE', 'NO_ACTION', 'INSUFFICIENT_DATA'];

export type EvaluationStatusV2 =
  /** Fully evaluated. */
  | 'EVALUATED'
  /** The decision carries no judgement, or the plan does not fit the decision: no score, the reason is stated. */
  | 'NOT_EVALUABLE'
  /** The plan's window has not completed yet, or a bar may still arrive (data grace period). Not recorded. */
  | 'PENDING'
  /** A bar of the window is missing after the grace period, or a bar is of another series. */
  | 'INSUFFICIENT_DATA'
  /** The order of events inside a bar cannot be determined and the plan asked for no assumption. */
  | 'INDETERMINATE';

export type Authenticity = 'unverified' | 'sealed_before_outcome' | 'historical_reconstruction';
export type OutcomeClassV2 = 'FAVORABLE' | 'FLAT' | 'ADVERSE';
export type ProcessQualityV2 = 'STRONG' | 'ACCEPTABLE' | 'WEAK' | 'UNKNOWN';
export type Quadrant = 'good_decision_good_outcome' | 'good_decision_bad_outcome' | 'bad_decision_good_outcome' | 'bad_decision_bad_outcome';

/** The decision-time checks of the process. Only an assessment made no later than the plan's first bar counts. */
export interface ProcessAssessment {
  assessedAt: string;
  dataQualityOk: boolean;
  rulesPassed: boolean;
  riskWithinLimits: boolean;
  /** The expected edge of the plan exceeded its modelled costs. */
  expectedEdgeExceedsCosts: boolean;
}

/** A forecast is scored only as a probability of a defined event, stated before the plan was sealed and before its first bar. */
export interface ForecastV2 {
  event: 'target_before_stop';
  probability: number;
  statedAt: string;
}

export interface DecisionV2 {
  decisionId: string;
  action: DecisionActionV2;
  positionContext: PositionContext;
  /** The plan this decision is evaluated against (see the header); absent for NO_ACTION and INSUFFICIENT_DATA. */
  plan?: SealedPlan;
  /** EXIT only: the fraction of the open quantity closed. R2 evaluates full exits only (1 or absent). */
  exitFraction?: number;
  process?: ProcessAssessment;
  forecast?: ForecastV2;
}

export interface EvaluationPolicyV2 {
  /** |value| up to this many R counts as flat. */
  flatBandR: string;
  /** A loss up to this many R (beyond 1R: costs and slippage) still counts as within the planned risk. */
  plannedRiskToleranceR: string;
}

export const DEFAULT_EVALUATION_POLICY_V2: EvaluationPolicyV2 = Object.freeze({ flatBandR: '0.1', plannedRiskToleranceR: '1.25' });

export interface EvaluationV2 {
  method: typeof OUTCOME_EVAL_V2;
  policyVersion: typeof OUTCOME_EVAL_V2_POLICY_VERSION;
  policy: EvaluationPolicyV2;
  decisionId: string;
  action: DecisionActionV2;
  positionContext: PositionContext;
  origin: EvaluationOrigin | null;
  realization: Realization | null;
  planId: string | null;
  planSchema: string | null;
  planHash: string | null;
  planSealedAt: string | null;
  planSequence: number | null;
  authenticity: Authenticity;
  evaluatedAt: string;
  status: EvaluationStatusV2;
  reasons: string[];
  /** The decision's value in R (see the header). null unless EVALUATED. */
  valueR: string | null;
  outcome: OutcomeClassV2 | null;
  process: ProcessQualityV2;
  quadrant: Quadrant | null;
  /** The loss of a position actually held (entry, hold) stayed within the planned risk. null without such a loss. */
  lossWithinPlannedRisk: boolean | null;
  dataQuality: { legacyBars: number; ambiguousBars: number; assumptionUsed: boolean };
  forecast: { event: ForecastV2['event']; probability: number; occurred: boolean | null; brier: number | null } | null;
  /** A single case is never evidence of skill. */
  evidence: 'single_case';
  simulation: PlanSimulation | null;
}

export interface EvaluateInputV2 {
  decision: DecisionV2;
  bars: readonly MarketBar[];
  calendar: TradingCalendar;
  evaluatedAt: string;
  policy?: EvaluationPolicyV2;
  simulation?: SimulationOptions;
}

function processQuality(a: ProcessAssessment | undefined, planStart: string, reasons: string[]): ProcessQualityV2 {
  if (!a) return 'UNKNOWN';
  if (parseUtc(a.assessedAt) > parseUtc(planStart)) {
    reasons.push('PROCESS_ASSESSED_AFTER_START');
    return 'UNKNOWN';
  }
  if (!a.rulesPassed || !a.riskWithinLimits) return 'WEAK';
  const soft = [a.dataQualityOk, a.expectedEdgeExceedsCosts].filter((ok) => !ok).length;
  return soft === 0 ? 'STRONG' : soft === 1 ? 'ACCEPTABLE' : 'WEAK';
}

function quadrantOf(process: ProcessQualityV2, outcome: OutcomeClassV2 | null): Quadrant | null {
  if (process === 'UNKNOWN' || outcome === null || outcome === 'FLAT') return null;
  const good = process !== 'WEAK';
  if (outcome === 'FAVORABLE') return good ? 'good_decision_good_outcome' : 'bad_decision_good_outcome';
  return good ? 'good_decision_bad_outcome' : 'bad_decision_bad_outcome';
}

type Expectation = { schema: typeof TRADE_PLAN_SCHEMA | typeof CONTINUATION_PLAN_SCHEMA; side?: 'long' | 'short'; context: PositionContext; avoided: boolean } | { notEvaluable: string };

function expectation(decision: DecisionV2): Expectation {
  const open = decision.positionContext === 'flat' ? null : decision.positionContext === 'long_open' ? 'long' : 'short';
  switch (decision.action) {
    case 'NO_ACTION':
      return { notEvaluable: 'NO_JUDGEMENT' };
    case 'INSUFFICIENT_DATA':
      return { notEvaluable: 'DECISION_HAD_INSUFFICIENT_DATA' };
    case 'ENTER_LONG':
      return open ? { notEvaluable: 'ENTRY_WITH_OPEN_POSITION' } : { schema: TRADE_PLAN_SCHEMA, side: 'long', context: 'flat', avoided: false };
    case 'ENTER_SHORT':
      return open ? { notEvaluable: 'ENTRY_WITH_OPEN_POSITION' } : { schema: TRADE_PLAN_SCHEMA, side: 'short', context: 'flat', avoided: false };
    case 'NO_TRADE':
      return open ? { notEvaluable: 'NO_TRADE_WITH_OPEN_POSITION' } : { schema: TRADE_PLAN_SCHEMA, context: 'flat', avoided: true };
    case 'HOLD':
      return open ? { schema: CONTINUATION_PLAN_SCHEMA, side: open, context: decision.positionContext, avoided: false } : { notEvaluable: 'HOLD_WITHOUT_POSITION' };
    case 'EXIT':
      if (!open) return { notEvaluable: 'EXIT_WITHOUT_POSITION' };
      if (decision.exitFraction !== undefined && decision.exitFraction !== 1) return { notEvaluable: 'PARTIAL_EXIT_NOT_SUPPORTED' };
      return { schema: CONTINUATION_PLAN_SCHEMA, side: open, context: decision.positionContext, avoided: true };
  }
}

/** Evaluates a decision whose plan the CALLER supplies. The seal is a claim: authenticity is always 'unverified'. */
export function evaluateDecisionV2(input: EvaluateInputV2): EvaluationV2 {
  return evaluate(input, false);
}

/**
 * Evaluates a decision against the plan READ FROM THE LEDGER (the caller names the plan; it cannot supply its seal). The seal is
 * the stored record: research and demo plans count as sealed_before_outcome only when stored strictly before their first bar.
 */
export async function evaluateDecisionFromLedger(input: Omit<EvaluateInputV2, 'decision'> & { ledger: TradePlanLedger; planId: string | null; decision: Omit<DecisionV2, 'plan'> }): Promise<EvaluationV2> {
  if (!(input.ledger instanceof TradePlanLedger)) throw new Error('a TradePlanLedger is required');
  const plan = input.planId === null ? null : await input.ledger.getVerified(input.planId);
  const decision: DecisionV2 = { ...input.decision, ...(plan ? { plan } : {}) };
  const result = evaluate({ ...input, decision }, true);
  if (input.planId !== null && plan === null) {
    result.status = 'NOT_EVALUABLE';
    result.reasons.splice(0, result.reasons.length, 'PLAN_NOT_IN_LEDGER');
  }
  return result;
}

function evaluate(input: EvaluateInputV2, fromLedger: boolean): EvaluationV2 {
  const { decision } = input;
  const policy = input.policy ?? DEFAULT_EVALUATION_POLICY_V2;
  const sealed = decision.plan;
  const plan = sealed?.plan;
  const reasons: string[] = [];
  const result: EvaluationV2 = {
    method: OUTCOME_EVAL_V2,
    policyVersion: OUTCOME_EVAL_V2_POLICY_VERSION,
    policy,
    decisionId: decision.decisionId,
    action: decision.action,
    positionContext: decision.positionContext,
    origin: plan?.origin ?? null,
    realization: plan?.realization ?? null,
    planId: plan?.planId ?? null,
    planSchema: plan?.schema ?? null,
    planHash: sealed?.planHash ?? null,
    planSealedAt: sealed?.sealedAt ?? null,
    planSequence: sealed?.sequence ?? null,
    authenticity: 'unverified',
    evaluatedAt: input.evaluatedAt,
    status: 'NOT_EVALUABLE',
    reasons,
    valueR: null,
    outcome: null,
    process: 'UNKNOWN',
    quadrant: null,
    lossWithinPlannedRisk: null,
    dataQuality: { legacyBars: 0, ambiguousBars: 0, assumptionUsed: false },
    forecast: null,
    evidence: 'single_case',
    simulation: null,
  };
  const notEvaluable = (reason: string): EvaluationV2 => {
    reasons.push(reason);
    return result;
  };

  if (!DECISION_ACTIONS_V2.includes(decision.action)) return notEvaluable('UNKNOWN_ACTION');
  const expected = expectation(decision);
  if ('notEvaluable' in expected) return notEvaluable(expected.notEvaluable);
  if (!sealed || !plan) return notEvaluable(decision.action === 'NO_TRADE' ? 'NO_CANDIDATE_PLAN' : expected.schema === CONTINUATION_PLAN_SCHEMA ? 'NO_POSITION_STATE' : 'NO_PLAN');
  if (SUPERSEDED_PLAN_SCHEMAS.includes(plan.schema)) return notEvaluable('PLAN_SCHEMA_SUPERSEDED');
  // The plan must be the one that was sealed, complete, belong to this decision and fit the action.
  if (tradePlanHash(plan) !== sealed.planHash) return notEvaluable('PLAN_HASH_MISMATCH');
  if (tradePlanProblems(plan).length > 0) return notEvaluable('PLAN_INCOMPLETE');
  if (plan.decisionId !== decision.decisionId) return notEvaluable('PLAN_OF_ANOTHER_DECISION');
  if (plan.schema !== expected.schema) return notEvaluable(expected.schema === CONTINUATION_PLAN_SCHEMA ? 'NO_POSITION_STATE' : 'ENTRY_PLAN_REQUIRED');
  if (plan.positionContext !== expected.context) return notEvaluable('PLAN_POSITION_CONTEXT_MISMATCH');
  if (expected.side !== undefined && planSideOf(plan) !== expected.side) return notEvaluable('PLAN_SIDE_DOES_NOT_FIT_ACTION');
  const start = planStartOf(plan);
  if (plan.origin === 'historical_simulation') {
    // Made now about the past: the evidence against hindsight is the data basis (asOf no later than the plan's start, checked
    // with the plan), never the wall-clock seal. It is labelled a reconstruction and never counts as a decision of that time.
    result.authenticity = fromLedger ? 'historical_reconstruction' : 'unverified';
  } else {
    // A live decision: stored strictly before its first bar, from data known when it was stored.
    if (parseUtc(sealed.sealedAt) >= parseUtc(start)) return notEvaluable('PLAN_SEALED_TOO_LATE');
    if (parseUtc(plan.dataBasis.asOf) > parseUtc(sealed.sealedAt)) return notEvaluable('PLAN_DATA_AFTER_SEAL');
    result.authenticity = fromLedger ? 'sealed_before_outcome' : 'unverified';
  }
  // The simulator produces hypothetical results only; a paper, demo or live result needs the observed fills.
  if (plan.realization !== 'HYPOTHETICAL') return notEvaluable('OBSERVED_FILLS_REQUIRED');

  result.process = processQuality(decision.process, start, reasons);
  const simulation = plan.schema === CONTINUATION_PLAN_SCHEMA ? simulateContinuation(plan, input.bars, input.calendar, input.evaluatedAt, input.simulation) : simulateTradePlan(plan, input.bars, input.calendar, input.evaluatedAt, input.simulation);
  result.simulation = simulation;
  result.dataQuality = { legacyBars: simulation.legacyBars, ambiguousBars: simulation.ambiguousBars, assumptionUsed: simulation.assumptionUsed };
  reasons.push(...simulation.reasons);
  if (simulation.status !== 'COMPLETED' || simulation.netR === null) {
    result.status = simulation.status === 'COMPLETED' ? 'INSUFFICIENT_DATA' : simulation.status;
    if (simulation.status === 'COMPLETED') reasons.push('NO_RISK_UNIT');
    return result;
  }

  const planR = Decimal.from(simulation.netR);
  const value = expected.avoided ? planR.negated() : planR;
  result.status = 'EVALUATED';
  result.valueR = value.toString();
  result.outcome = value.abs().lte(Decimal.from(policy.flatBandR)) ? 'FLAT' : value.isNegative() ? 'ADVERSE' : 'FAVORABLE';
  result.quadrant = quadrantOf(result.process, result.outcome);
  if (!expected.avoided) result.lossWithinPlannedRisk = planR.isNegative() ? planR.abs().lte(Decimal.from(policy.plannedRiskToleranceR)) : null;

  const f = decision.forecast;
  if (f) {
    const deadline = Math.min(parseUtc(sealed.sealedAt), parseUtc(start));
    if (parseUtc(f.statedAt) > deadline || !(f.probability >= 0 && f.probability <= 1)) {
      reasons.push('FORECAST_NOT_SCORED');
    } else {
      const reason = simulation.exit?.reason;
      // The event is determined only by a target or stop exit without an assumption; a time exit or an assumed order is no outcome.
      const occurred = plan.takeProfit === undefined || simulation.assumptionUsed || reason === 'time' ? null : reason === 'target' || reason === 'target_gap';
      result.forecast = { event: f.event, probability: f.probability, occurred, brier: occurred === null ? null : (f.probability - (occurred ? 1 : 0)) ** 2 };
    }
  }
  return result;
}
