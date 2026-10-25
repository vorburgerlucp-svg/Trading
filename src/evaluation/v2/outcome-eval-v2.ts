// R2 Learning Evaluation v2 (outcome-eval:v2). Evaluates one decision against the trade plan that was sealed before its outcome
// could be known. v1 (src/evaluation/outcome-evaluator.ts) stays unchanged for old records and reviews.
//
// What is evaluated against what:
//   ENTER_LONG / ENTER_SHORT  (flat)      the entered plan; value = its net R
//   HOLD                      (open)      the continuation plan of the OPEN side; value = its net R (HOLD without a position: not evaluable)
//   EXIT                      (open)      the continuation plan the exit avoided; value = minus its net R
//   NO_TRADE                  (flat)      the rejected candidate plan; value = minus its net R. Without a concrete plan: not evaluable
//   NO_ACTION, INSUFFICIENT_DATA         no judgement: never scored, only counted
// The decision's quality is kept apart from its result: process quality (assessed at decision time), outcome (net R of the plan),
// data quality, risk compliance, and forecast quality (only for an explicit probability of a defined event). A single case is
// never evidence of skill: aggregates and their sample sizes are in evaluation-summary.ts.

import type { MarketBar } from '../../market-data/market-data-types.js';
import type { TradingCalendar } from '../../market-data/sessions.js';
import { parseUtc } from '../../market-data/time.js';
import { Decimal } from '../../money/decimal.js';
import type { SealedPlan } from './plan-ledger.js';
import { simulateTradePlan, type PlanSimulation } from './plan-simulator.js';
import { OUTCOME_EVAL_V2, tradePlanHash, type EvaluationOrigin, type PositionContext, type Realization } from './trade-plan.js';

export const OUTCOME_EVAL_V2_POLICY_VERSION = 'outcome-eval-policy:v2.0' as const;

export type DecisionActionV2 = 'ENTER_LONG' | 'ENTER_SHORT' | 'EXIT' | 'HOLD' | 'NO_TRADE' | 'NO_ACTION' | 'INSUFFICIENT_DATA';
export const DECISION_ACTIONS_V2: readonly DecisionActionV2[] = ['ENTER_LONG', 'ENTER_SHORT', 'EXIT', 'HOLD', 'NO_TRADE', 'NO_ACTION', 'INSUFFICIENT_DATA'];

export type EvaluationStatusV2 =
  /** Fully evaluated. */
  | 'EVALUATED'
  /** The decision carries no judgement, or the plan does not fit the decision: no score, the reason is stated. */
  | 'NOT_EVALUABLE'
  /** The holding window has not completed yet. */
  | 'PENDING'
  /** A bar of the holding window is missing, or a bar is of another series. */
  | 'INSUFFICIENT_DATA'
  /** The order of events inside a bar cannot be determined and the plan asked for no assumption. */
  | 'INDETERMINATE';

export type OutcomeClassV2 = 'FAVORABLE' | 'FLAT' | 'ADVERSE';
export type ProcessQualityV2 = 'STRONG' | 'ACCEPTABLE' | 'WEAK' | 'UNKNOWN';
export type Quadrant = 'good_decision_good_outcome' | 'good_decision_bad_outcome' | 'bad_decision_good_outcome' | 'bad_decision_bad_outcome';

/** The decision-time checks of the process. Only an assessment made no later than the earliest entry counts. */
export interface ProcessAssessment {
  assessedAt: string;
  dataQualityOk: boolean;
  rulesPassed: boolean;
  riskWithinLimits: boolean;
  /** The expected edge of the plan exceeded its modelled costs. */
  expectedEdgeExceedsCosts: boolean;
}

/** A forecast is scored only as a probability of a defined event, stated before the plan was sealed. */
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
  planHash: string | null;
  planSealedAt: string | null;
  evaluatedAt: string;
  status: EvaluationStatusV2;
  reasons: string[];
  /** The decision's value in R (see the header). null unless EVALUATED. */
  valueR: string | null;
  outcome: OutcomeClassV2 | null;
  process: ProcessQualityV2;
  quadrant: Quadrant | null;
  /** The loss stayed within the planned risk (the stop worked as planned). null without a loss. */
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
}

function processQuality(decision: DecisionV2, plan: SealedPlan | undefined, reasons: string[]): ProcessQualityV2 {
  const a = decision.process;
  if (!a) return 'UNKNOWN';
  if (plan && parseUtc(a.assessedAt) > parseUtc(plan.plan.entry.earliestEntryAt)) {
    reasons.push('PROCESS_ASSESSED_AFTER_ENTRY');
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

/** Which plan side and context an action requires, and whether its value is the plan's result or the result it avoided. */
function expectation(decision: DecisionV2): { side?: 'long' | 'short'; context: PositionContext[]; avoided: boolean } | { notEvaluable: string } {
  switch (decision.action) {
    case 'NO_ACTION':
      return { notEvaluable: 'NO_JUDGEMENT' };
    case 'INSUFFICIENT_DATA':
      return { notEvaluable: 'DECISION_HAD_INSUFFICIENT_DATA' };
    case 'ENTER_LONG':
      return { side: 'long', context: ['flat'], avoided: false };
    case 'ENTER_SHORT':
      return { side: 'short', context: ['flat'], avoided: false };
    case 'NO_TRADE':
      return { context: ['flat'], avoided: true };
    case 'HOLD':
      if (decision.positionContext === 'flat') return { notEvaluable: 'HOLD_WITHOUT_POSITION' };
      return { side: decision.positionContext === 'long_open' ? 'long' : 'short', context: [decision.positionContext], avoided: false };
    case 'EXIT':
      if (decision.positionContext === 'flat') return { notEvaluable: 'EXIT_WITHOUT_POSITION' };
      return { side: decision.positionContext === 'long_open' ? 'long' : 'short', context: [decision.positionContext], avoided: true };
  }
}

export function evaluateDecisionV2(input: EvaluateInputV2): EvaluationV2 {
  const { decision } = input;
  const policy = input.policy ?? DEFAULT_EVALUATION_POLICY_V2;
  const sealed = decision.plan;
  const reasons: string[] = [];
  const base: EvaluationV2 = {
    method: OUTCOME_EVAL_V2,
    policyVersion: OUTCOME_EVAL_V2_POLICY_VERSION,
    policy,
    decisionId: decision.decisionId,
    action: decision.action,
    positionContext: decision.positionContext,
    origin: sealed?.plan.origin ?? null,
    realization: sealed?.plan.realization ?? null,
    planId: sealed?.plan.planId ?? null,
    planHash: sealed?.planHash ?? null,
    planSealedAt: sealed?.sealedAt ?? null,
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
    return base;
  };

  if (!DECISION_ACTIONS_V2.includes(decision.action)) return notEvaluable('UNKNOWN_ACTION');
  const expected = expectation(decision);
  if ('notEvaluable' in expected) return notEvaluable(expected.notEvaluable);
  if (!expected.context.includes(decision.positionContext)) return notEvaluable('ACTION_DOES_NOT_FIT_POSITION_CONTEXT');
  if (!sealed) return notEvaluable(decision.action === 'NO_TRADE' ? 'NO_CANDIDATE_PLAN' : 'NO_PLAN');
  const plan = sealed.plan;
  // The plan must be the one that was sealed, belong to this decision and fit the action.
  if (tradePlanHash(plan) !== sealed.planHash) return notEvaluable('PLAN_HASH_MISMATCH');
  if (plan.decisionId !== decision.decisionId) return notEvaluable('PLAN_OF_ANOTHER_DECISION');
  if (plan.evaluationMethod !== OUTCOME_EVAL_V2) return notEvaluable('PLAN_FOR_ANOTHER_METHOD');
  if (plan.positionContext !== decision.positionContext) return notEvaluable('PLAN_POSITION_CONTEXT_MISMATCH');
  if (expected.side !== undefined && plan.side !== expected.side) return notEvaluable('PLAN_SIDE_DOES_NOT_FIT_ACTION');
  // Sealed before anything about the outcome could be known: strictly before the earliest entry, and made from data known then.
  if (parseUtc(sealed.sealedAt) >= parseUtc(plan.entry.earliestEntryAt)) return notEvaluable('PLAN_SEALED_TOO_LATE');
  if (parseUtc(plan.dataBasis.asOf) > parseUtc(sealed.sealedAt)) return notEvaluable('PLAN_DATA_AFTER_SEAL');
  // The simulator produces hypothetical results only; a paper, demo or live result needs the observed fills.
  if (plan.realization !== 'HYPOTHETICAL') return notEvaluable('OBSERVED_FILLS_REQUIRED');

  base.process = processQuality(decision, sealed, reasons);
  const simulation = simulateTradePlan(plan, input.bars, input.calendar, input.evaluatedAt);
  base.simulation = simulation;
  base.dataQuality = { legacyBars: simulation.legacyBars, ambiguousBars: simulation.ambiguousBars, assumptionUsed: simulation.assumptionUsed };
  reasons.push(...simulation.reasons);
  if (simulation.status !== 'COMPLETED' || simulation.netR === null) {
    base.status = simulation.status === 'COMPLETED' ? 'INSUFFICIENT_DATA' : simulation.status;
    return base;
  }

  const planR = Decimal.from(simulation.netR);
  const value = expected.avoided ? planR.negated() : planR;
  const band = Decimal.from(policy.flatBandR);
  base.status = 'EVALUATED';
  base.valueR = value.toString();
  base.outcome = value.abs().lte(band) ? 'FLAT' : value.isNegative() ? 'ADVERSE' : 'FAVORABLE';
  base.quadrant = quadrantOf(base.process, base.outcome);
  // Risk compliance of the plan that was actually held (enter, hold): did a loss stay within the planned risk?
  if (!expected.avoided) base.lossWithinPlannedRisk = planR.isNegative() ? planR.abs().lte(Decimal.from(policy.plannedRiskToleranceR)) : null;

  const f = decision.forecast;
  if (f) {
    if (parseUtc(f.statedAt) > parseUtc(sealed.sealedAt) || !(f.probability >= 0 && f.probability <= 1)) {
      reasons.push('FORECAST_NOT_SCORED');
    } else {
      const reason = simulation.exit?.reason;
      // The event is determined only by a target or stop exit without an assumption; a time exit or an assumed order is no outcome.
      const occurred = plan.takeProfit === undefined || simulation.assumptionUsed || reason === 'time' ? null : reason === 'target' || reason === 'target_gap';
      base.forecast = { event: f.event, probability: f.probability, occurred, brier: occurred === null ? null : (f.probability - (occurred ? 1 : 0)) ** 2 };
    }
  }
  return base;
}
