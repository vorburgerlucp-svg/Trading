// Outcome Evaluator: links Decision → Prediction → Action → Outcome and turns outcomes into
// measured model performance (the only way NEXUS "learns" which specialist is good at what).
//
// Outcomes are evaluated even for NO_ACTION decisions (counterfactual market move), so a model that
// correctly said "no trade" before a -12 % move gets credit. Outcomes must be known AFTER the
// decision (no look-ahead); observations become visible only from `knownAt`.

import type { ModelPerformance, PerformanceObservation } from '../ai/model-performance.js';
import type { Recommendation } from '../ai/model-types.js';
import type { NexusMemory } from '../memory/nexus-memory.js';
import { Decimal } from '../money/decimal.js';
import { ratioBp, rappen, subChf, type Rappen } from '../money/money.js';
import type { AuditLog } from '../audit/audit-log.js';
import type { AttemptRecord, DecisionTrace } from '../nexus/nexus-types.js';

export interface TradeOutcome {
  kind: 'trade';
  decisionId: string;
  instrumentId: string;
  /** Whether a (paper or real) position was actually taken; false = counterfactual evaluation. */
  executed: boolean;
  entryPrice: Decimal;
  exitPrice: Decimal;
  stopLoss?: Decimal;
  takeProfit?: Decimal;
  highestPrice: Decimal;
  lowestPrice: Decimal;
  feesChf: Rappen;
  netResultChf: Rappen;
  openedAt: string;
  closedAt: string;
  knownAt: string;
}

export interface PhysicalOutcome {
  kind: 'physical';
  decisionId: string;
  productId: string;
  units: number;
  predicted: { unitCostChf: Rappen; salePriceChf: Rappen; daysToSell: number; netProfitPerUnitChf: Rappen };
  actual: { unitCostChf: Rappen; averageSalePriceChf: Rappen; daysToSell: number; feesChf: Rappen; returnsChf: Rappen; netProfitChf: Rappen; unitsSold: number };
  knownAt: string;
}

export interface TradeEvaluation {
  kind: 'trade';
  returnBp: number;
  maxAdverseExcursionBp: number;
  maxFavorableExcursionBp: number;
  stop: 'not_set' | 'not_hit' | 'hit' | 'hit_then_recovered';
  target: 'not_set' | 'reached' | 'not_reached';
  feesChf: Rappen;
  netResultChf: Rappen;
  directionCorrect: boolean | null;
}

export interface PhysicalEvaluation {
  kind: 'physical';
  returnBp: number;
  marginBp: number | null;
  priceErrorBp: number;
  durationErrorDays: number;
  profitErrorChf: Rappen;
  capitalBindingDays: number;
  sellThroughBp: number;
}

export class EvaluationError extends Error {
  override readonly name = 'EvaluationError';
}

/** Return band (bp) inside which a move counts as flat. */
export const FLAT_BAND_BP = 50;

export function evaluateTrade(outcome: TradeOutcome, predictedDirection: string | null): TradeEvaluation {
  const bp = (price: Decimal) => outcome.entryPrice.isZero() ? 0 : Number(price.minus(outcome.entryPrice).times(10_000).dividedBy(outcome.entryPrice, 0, 'half_even').toString());
  const returnBp = bp(outcome.exitPrice);
  let stop: TradeEvaluation['stop'] = 'not_set';
  if (outcome.stopLoss) stop = outcome.lowestPrice.lte(outcome.stopLoss) ? (outcome.exitPrice.gt(outcome.entryPrice) ? 'hit_then_recovered' : 'hit') : 'not_hit';
  const target: TradeEvaluation['target'] = outcome.takeProfit ? (outcome.highestPrice.gte(outcome.takeProfit) ? 'reached' : 'not_reached') : 'not_set';
  let directionCorrect: boolean | null = null;
  if (predictedDirection === 'bullish') directionCorrect = returnBp > FLAT_BAND_BP;
  else if (predictedDirection === 'bearish') directionCorrect = returnBp < -FLAT_BAND_BP;
  else if (predictedDirection === 'neutral') directionCorrect = Math.abs(returnBp) <= FLAT_BAND_BP;
  return {
    kind: 'trade',
    returnBp,
    maxAdverseExcursionBp: Math.min(0, bp(outcome.lowestPrice)),
    maxFavorableExcursionBp: Math.max(0, bp(outcome.highestPrice)),
    stop,
    target,
    feesChf: outcome.feesChf,
    netResultChf: outcome.netResultChf,
    directionCorrect,
  };
}

export function evaluatePhysical(outcome: PhysicalOutcome): PhysicalEvaluation {
  const { predicted, actual, units } = outcome;
  if (!Number.isInteger(units) || units <= 0) throw new EvaluationError('units must be a positive integer');
  const invested = rappen(actual.unitCostChf * BigInt(units));
  const revenue = rappen(actual.averageSalePriceChf * BigInt(actual.unitsSold));
  return {
    kind: 'physical',
    returnBp: ratioBp(actual.netProfitChf, invested),
    marginBp: revenue > 0n ? ratioBp(actual.netProfitChf, revenue) : null,
    priceErrorBp: ratioBp(subChf(actual.averageSalePriceChf, predicted.salePriceChf), predicted.salePriceChf),
    durationErrorDays: actual.daysToSell - predicted.daysToSell,
    profitErrorChf: subChf(actual.netProfitChf, rappen(predicted.netProfitPerUnitChf * BigInt(units))),
    capitalBindingDays: actual.daysToSell,
    sellThroughBp: Math.round((actual.unitsSold / units) * 10_000),
  };
}

/** 0..1 score of one recommendation against the realized return. */
export function scoreRecommendation(recommendation: Recommendation, returnBp: number): number {
  const up = returnBp > FLAT_BAND_BP;
  const down = returnBp < -FLAT_BAND_BP;
  switch (recommendation) {
    case 'buy':
      return up ? 1 : down ? 0 : 0.5;
    case 'sell':
      return down ? 1 : up ? 0 : 0.5;
    case 'hold':
    case 'no_trade':
      return down ? 1 : up ? 0 : 0.5;
  }
}

/** A critic/counter-analyst is right when it warned (blocking/major flag) before a loss, or stayed quiet before a gain. */
export function scoreWarning(warned: boolean, returnBp: number): number {
  if (Math.abs(returnBp) <= FLAT_BAND_BP) return 0.5;
  const loss = returnBp < 0;
  return warned === loss ? 1 : 0;
}

export class OutcomeEvaluator {
  constructor(
    private readonly memory: NexusMemory,
    private readonly performance: ModelPerformance,
    private readonly audit?: AuditLog,
  ) {}

  async evaluate(record: DecisionTrace, outcome: TradeOutcome | PhysicalOutcome): Promise<{ evaluation: TradeEvaluation | PhysicalEvaluation; observations: PerformanceObservation[] }> {
    const decision = record.decision;
    if (outcome.decisionId !== decision.decisionId) throw new EvaluationError('outcome belongs to another decision');
    if (Date.parse(outcome.knownAt) <= Date.parse(decision.asOf)) throw new EvaluationError('outcome must become known after the decision (look-ahead protection)');

    const evaluation = outcome.kind === 'trade' ? evaluateTrade(outcome, decision.direction) : evaluatePhysical(outcome);
    await this.memory.remember({
      id: decision.decisionId + ':outcome',
      kind: outcome.kind === 'trade' ? 'trade' : 'business',
      subject: outcome.kind === 'trade' ? outcome.instrumentId : outcome.productId,
      tags: ['decision:' + decision.decisionId, 'outcome:' + decision.outcome],
      content: { decisionId: decision.decisionId, action: decision.outcome, outcome, evaluation },
      occurredAt: decision.asOf,
      availableAt: outcome.knownAt,
      source: 'outcome-evaluator',
    });
    await this.audit?.record({
      eventId: decision.decisionId + ':outcome',
      type: 'OUTCOME_RECORDED',
      occurredAt: outcome.knownAt,
      decisionId: decision.decisionId,
      taskId: decision.taskId,
      actor: { kind: 'system', id: 'outcome-evaluator' },
      payload: { outcome, evaluation },
    });

    const observations: PerformanceObservation[] = [];
    for (const attempt of record.attempts) {
      if (attempt.status !== 'ok' || !attempt.opinion) continue;
      const step = record.plan.steps.find((s) => s.id === attempt.stepId);
      const observation: PerformanceObservation = {
        modelKey: attempt.modelKey,
        domain: record.task.domain,
        subtask: step?.subtask ?? record.task.subtask,
        role: attempt.role,
        decisionId: decision.decisionId,
        score: scoreAttempt(attempt, evaluation.returnBp),
        shadow: attempt.shadow,
        occurredAt: decision.asOf,
        availableAt: outcome.knownAt,
      };
      await this.performance.record(decision.decisionId + ':perf:' + attempt.stepId + ':' + attempt.modelKey, observation);
      observations.push(observation);
    }
    return { evaluation, observations };
  }
}

function scoreAttempt(attempt: AttemptRecord, returnBp: number): number {
  const opinion = attempt.opinion;
  if (!opinion) return 0;
  if (attempt.role === 'analyst') return scoreRecommendation(opinion.recommendation, returnBp);
  const warned = opinion.riskFlags.some((f) => f.severity === 'blocking' || f.severity === 'major');
  return scoreWarning(warned, returnBp);
}
