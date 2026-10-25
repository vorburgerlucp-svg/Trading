// R2: aggregates of v2 evaluations. An aggregate is built from ONE origin and ONE realization only (historical simulation,
// research and demo results, hypothetical and observed results are never mixed), and it states how much it can say: below the
// minimum sample size it is descriptive only, and a confidence interval is given for the mean value. A single gain is never
// evidence of a better strategy, and a loss within the planned risk is not by itself a bad decision (see the quadrants).

import { Decimal } from '../../money/decimal.js';
import type { Authenticity, EvaluationStatusV2, EvaluationV2, Quadrant } from './outcome-eval-v2.js';
import type { EvaluationOrigin, Realization } from './trade-plan.js';

export const EVALUATION_SUMMARY_VERSION = 'evaluation-summary:v2' as const;

export class EvaluationMixError extends Error {
  override readonly name = 'EvaluationMixError';
}

export interface EvaluationSummaryV2 {
  version: typeof EVALUATION_SUMMARY_VERSION;
  origin: EvaluationOrigin;
  realization: Realization;
  policyVersion: string | null;
  authenticity: Partial<Record<Authenticity, number>>;
  total: number;
  byStatus: Partial<Record<EvaluationStatusV2, number>>;
  evaluated: number;
  meanR: string | null;
  /** Normal-approximation 95 % interval of the mean value (descriptive below minSamples). */
  ci95R: [string, string] | null;
  quadrants: Partial<Record<Quadrant, number>>;
  /** Results that rest on the conservative intrabar assumption. */
  assumptionBased: number;
  minSamples: number;
  /** false: too few evaluated cases for any statement beyond description. */
  sufficientSample: boolean;
  /** Mean Brier score of scored forecasts. */
  meanBrier: number | null;
}

/**
 * Summarizes evaluations of exactly one origin, one realization and one policy version; any other record is a refusal, not a filter.
 * Research and demo aggregates also refuse caller-supplied (unverified) plans unless `allowUnverified` (synthetic tests only).
 */
export function summarizeEvaluationsV2(records: readonly EvaluationV2[], scope: { origin: EvaluationOrigin; realization: Realization; minSamples?: number; allowUnverified?: boolean }): EvaluationSummaryV2 {
  const minSamples = scope.minSamples ?? 30;
  const versions = new Set(records.map((r) => r.policyVersion));
  if (versions.size > 1) throw new EvaluationMixError('evaluations of different policy versions are never mixed: ' + [...versions].join(', '));
  if (scope.origin !== 'historical_simulation' && !scope.allowUnverified) {
    const unverified = records.find((r) => r.origin !== null && r.authenticity === 'unverified');
    if (unverified) throw new EvaluationMixError('evaluation ' + unverified.decisionId + ' rests on a caller-supplied plan: a ' + scope.origin + ' aggregate needs plans read from the ledger');
  }
  for (const r of records) {
    if (r.status !== 'NOT_EVALUABLE' || r.origin !== null) {
      if (r.origin !== scope.origin || r.realization !== scope.realization) {
        throw new EvaluationMixError('evaluation ' + r.decisionId + ' is ' + r.origin + '/' + r.realization + ', not ' + scope.origin + '/' + scope.realization + ': sources are never mixed');
      }
    }
  }
  const byStatus: EvaluationSummaryV2['byStatus'] = {};
  const quadrants: EvaluationSummaryV2['quadrants'] = {};
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.quadrant) quadrants[r.quadrant] = (quadrants[r.quadrant] ?? 0) + 1;
  }
  const values = records.filter((r) => r.status === 'EVALUATED' && r.valueR !== null).map((r) => Decimal.from(r.valueR!));
  const n = values.length;
  let meanR: string | null = null;
  let ci95R: [string, string] | null = null;
  if (n > 0) {
    const mean = values.reduce((s, v) => s.plus(v), Decimal.ZERO).dividedBy(n, 6, 'half_even');
    meanR = mean.toString();
    if (n > 1) {
      const m = mean.toNumber();
      const variance = values.reduce((s, v) => s + (v.toNumber() - m) ** 2, 0) / (n - 1);
      const half = 1.96 * Math.sqrt(variance / n);
      ci95R = [(m - half).toFixed(6), (m + half).toFixed(6)];
    }
  }
  const briers = records.map((r) => r.forecast?.brier).filter((b): b is number => typeof b === 'number');
  return {
    version: EVALUATION_SUMMARY_VERSION,
    origin: scope.origin,
    realization: scope.realization,
    policyVersion: records[0]?.policyVersion ?? null,
    authenticity: records.reduce<Partial<Record<Authenticity, number>>>((acc, r) => ({ ...acc, [r.authenticity]: (acc[r.authenticity] ?? 0) + 1 }), {}),
    total: records.length,
    byStatus,
    evaluated: n,
    meanR,
    ci95R,
    quadrants,
    assumptionBased: records.filter((r) => r.dataQuality.assumptionUsed).length,
    minSamples,
    sufficientSample: n >= minSamples,
    meanBrier: briers.length === 0 ? null : briers.reduce((s, b) => s + b, 0) / briers.length,
  };
}
