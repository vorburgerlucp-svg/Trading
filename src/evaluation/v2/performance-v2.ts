// R2: turns a v2 evaluation into a model performance observation labelled outcome-eval:v2. Such observations are QUARANTINED:
// ModelPerformance stores them, but no score, route, registry entry or champion decision uses them until outcome-eval:v2 is
// added to the accepted methods (a human decision after an independent validation). The score mapping is provisional and part
// of the method version.
//   analyst      score = clamp(0.5 + 0.25 × valueR, 0, 1) of an EVALUATED decision;
//   critic, counter-analyst: a warning is NOT scored against the outcome (v1 did, and rewarded silence before gains). It is
//                scored only as a forecast (Brier score of a stated probability of a defined event), in the evaluation record.

import type { ModelPerformance, PerformanceObservation } from '../../ai/model-performance.js';
import type { CouncilRole, Domain, ModelKey, Subtask } from '../../ai/model-types.js';
import { parseUtc } from '../../market-data/time.js';
import type { EvaluationV2 } from './outcome-eval-v2.js';
import { OUTCOME_EVAL_V2 } from './trade-plan.js';

export interface AttemptRefV2 {
  modelKey: ModelKey;
  role: CouncilRole;
  domain: Domain;
  subtask: Subtask;
  shadow: boolean;
  /** The decision time. */
  occurredAt: string;
}

export function performanceObservationOfV2(evaluation: EvaluationV2, attempt: AttemptRefV2): PerformanceObservation | null {
  if (evaluation.status !== 'EVALUATED' || evaluation.valueR === null || attempt.role !== 'analyst') return null;
  if (evaluation.planSealedAt === null || parseUtc(evaluation.evaluatedAt) <= parseUtc(evaluation.planSealedAt)) return null;
  const score = Math.min(1, Math.max(0, 0.5 + 0.25 * Number(evaluation.valueR)));
  return {
    modelKey: attempt.modelKey,
    domain: attempt.domain,
    subtask: attempt.subtask,
    role: attempt.role,
    decisionId: evaluation.decisionId,
    score,
    shadow: attempt.shadow,
    occurredAt: attempt.occurredAt,
    availableAt: evaluation.evaluatedAt,
    scoringMethod: OUTCOME_EVAL_V2,
  };
}

/** Records a v2 observation (quarantined by ModelPerformance). Refuses anything that is not labelled outcome-eval:v2. */
export async function recordQuarantinedV2(performance: ModelPerformance, observation: PerformanceObservation): Promise<void> {
  if (observation.scoringMethod !== OUTCOME_EVAL_V2) throw new Error('only outcome-eval:v2 observations are recorded here');
  await performance.record(observation.decisionId + ':perf-v2:' + observation.modelKey, observation);
}
