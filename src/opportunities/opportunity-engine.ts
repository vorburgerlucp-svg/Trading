// Opportunity Engine: validates opportunity inputs, computes deterministic scores, applies hard
// eligibility gates and enforces the status lifecycle.
//
// "AI proposes. Quant verifies.": an AI may deliver the thesis and estimates, but it never sets its
// own score. Scores are computed here from the estimates, with a documented, configurable formula.

import { Decimal } from '../money/decimal.js';
import { chfRounded, chfToDecimal, prorateChf, ratioBp, ratioNumber, ZERO_CHF, type Rappen } from '../money/money.js';
import type {
  Actor,
  CapitalBucket,
  Opportunity,
  OpportunityInput,
  OpportunityScores,
  OpportunityStatus,
  OpportunityType,
  ScoreComponent,
} from './opportunity-types.js';

export class OpportunityError extends Error {
  override readonly name = 'OpportunityError';
}

export interface ScoringConfig {
  weights: Record<ScoreComponent, number>;
  /** Daily risk-adjusted return at which the return component reaches 0.5 (saturation x / (x + k)). */
  halfSaturationDailyReturn: number;
  /** Floor for the holding period, so very short holds do not explode per-day figures. */
  minHoldingDays: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = Object.freeze({
  weights: Object.freeze({ return: 0.35, safety: 0.2, risk: 0.15, liquidity: 0.15, effort: 0.05, regulatory: 0.1 }),
  halfSaturationDailyReturn: 0.005,
  minHoldingDays: 1,
});

const BUCKETS: Record<OpportunityType, CapitalBucket> = {
  stock: 'equities',
  etf: 'equities',
  ipo: 'equities',
  crypto: 'crypto',
  forex: 'forex',
  commodity: 'commodities',
  future: 'derivatives',
  physical_product: 'physical_trade',
  reselling: 'physical_trade',
  wholesale: 'physical_trade',
  arbitrage: 'physical_trade',
  dropshipping: 'business',
  online_shop: 'business',
  business: 'business',
};

export function bucketFor(type: OpportunityType): CapitalBucket {
  return BUCKETS[type];
}

const TRANSITIONS: Record<OpportunityStatus, readonly OpportunityStatus[]> = {
  discovered: ['research', 'rejected'],
  research: ['approved', 'rejected'],
  approved: ['funded', 'rejected'],
  funded: ['active', 'exited'],
  active: ['exited'],
  exited: [],
  rejected: [],
};

export function validateOpportunityInput(input: OpportunityInput): string[] {
  const errors: string[] = [];
  const unit = (value: number, label: string) => {
    if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(label + ' must be within 0..1');
  };
  if (input.id.trim() === '') errors.push('id is required');
  if (!(input.type in BUCKETS)) errors.push('unknown type "' + input.type + '"');
  if (input.name.trim() === '') errors.push('name is required');
  if (input.requiredCapitalChf <= 0n) errors.push('requiredCapitalChf must be positive');
  if (input.downsideChf < 0n) errors.push('downsideChf must be a non-negative amount');
  if (!Number.isFinite(input.expectedHoldingDays) || input.expectedHoldingDays <= 0) errors.push('expectedHoldingDays must be positive');
  unit(input.liquidityScore, 'liquidityScore');
  unit(input.confidenceScore, 'confidenceScore');
  unit(input.riskScore, 'riskScore');
  unit(input.effortScore, 'effortScore');
  unit(input.regulatoryRiskScore, 'regulatoryRiskScore');
  if (input.thesis.length === 0) errors.push('at least one thesis point is required');
  if (input.exitPlan.trim() === '') errors.push('an exit plan is required');
  if (Number.isNaN(Date.parse(input.estimates.asOf))) errors.push('estimates.asOf is not a valid timestamp');
  if (input.sizing.kind === 'scalable') {
    const { minTicketChf, maxCapitalChf, lotSizeChf } = input.sizing;
    if (lotSizeChf <= 0n) errors.push('lotSizeChf must be positive');
    if (minTicketChf <= 0n) errors.push('minTicketChf must be positive');
    if (minTicketChf > maxCapitalChf) errors.push('minTicketChf exceeds maxCapitalChf');
  }
  return errors;
}

export function scoreOpportunity(input: OpportunityInput, config: ScoringConfig = DEFAULT_SCORING_CONFIG): OpportunityScores {
  const required = input.requiredCapitalChf;
  const riskAdjustedProfitChf = riskAdjustedProfit(input.expectedNetProfitChf, input.downsideChf, input.confidenceScore);
  const days = Math.max(config.minHoldingDays, input.expectedHoldingDays);
  const dailyRiskAdjustedReturn = ratioNumber(riskAdjustedProfitChf, required) / days;
  const k = config.halfSaturationDailyReturn;

  const components: Record<ScoreComponent, number> = {
    return: dailyRiskAdjustedReturn <= 0 ? 0 : dailyRiskAdjustedReturn / (dailyRiskAdjustedReturn + k),
    safety: 1 - clamp01(ratioNumber(input.downsideChf, required)),
    risk: 1 - input.riskScore,
    liquidity: input.liquidityScore,
    effort: 1 - input.effortScore,
    regulatory: 1 - input.regulatoryRiskScore,
  };

  let weighted = 0;
  let weightSum = 0;
  for (const [component, weight] of Object.entries(config.weights) as [ScoreComponent, number][]) {
    weighted += weight * components[component];
    weightSum += weight;
  }

  return {
    expectedReturnBp: ratioBp(input.expectedNetProfitChf, required),
    riskAdjustedProfitChf,
    dailyRiskAdjustedReturn,
    capitalEfficiencyScore: round1(100 * components.return),
    opportunityScore: round1(weightSum === 0 ? 0 : (100 * weighted) / weightSum),
    components,
  };
}

/** Hard gates that no score can outweigh. */
export function checkEligibility(input: OpportunityInput, scores: OpportunityScores): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.estimates.dataStatus === 'not_connected') reasons.push('DATA NOT CONNECTED: estimates are not backed by connected data');
  if (input.estimates.dataStatus === 'stale') reasons.push('estimates are based on stale data');
  if (input.expectedNetProfitChf <= 0n) reasons.push('no positive expected net profit after costs');
  if (scores.riskAdjustedProfitChf <= 0n) reasons.push('risk-adjusted profit is not positive');
  if (input.regulatoryBlocked) reasons.push('regulatory block');
  return { eligible: reasons.length === 0, reasons };
}

export function createOpportunity(input: OpportunityInput, config: ScoringConfig = DEFAULT_SCORING_CONFIG): Opportunity {
  const errors = validateOpportunityInput(input);
  if (errors.length > 0) throw new OpportunityError('invalid opportunity "' + input.id + '": ' + errors.join('; '));
  const scores = scoreOpportunity(input, config);
  return Object.freeze({
    ...input,
    status: 'discovered',
    bucket: bucketFor(input.type),
    scores,
    eligibility: checkEligibility(input, scores),
    history: Object.freeze([]),
  });
}

/** Returns a new opportunity with the status changed. Moving to 'approved' requires a human and an eligible opportunity. */
export function transitionOpportunity(
  opportunity: Opportunity,
  to: OpportunityStatus,
  change: { at: string; by: Actor; reason: string },
): Opportunity {
  const allowed = TRANSITIONS[opportunity.status];
  if (!allowed.includes(to)) throw new OpportunityError('transition ' + opportunity.status + ' → ' + to + ' is not allowed');
  if (change.reason.trim() === '') throw new OpportunityError('a status change needs a reason');
  if (to === 'approved') {
    if (change.by.kind !== 'human') throw new OpportunityError('only a human can approve an opportunity for funding');
    if (!opportunity.eligibility.eligible) throw new OpportunityError('cannot approve an ineligible opportunity: ' + opportunity.eligibility.reasons.join('; '));
  }
  return Object.freeze({
    ...opportunity,
    status: to,
    history: Object.freeze([...opportunity.history, { from: opportunity.status, to, ...change }]),
  });
}

/** Eligible first, then by opportunity score (desc), then by id for a stable, deterministic order. */
export function rankOpportunities(opportunities: readonly Opportunity[]): Opportunity[] {
  return [...opportunities].sort((a, b) => {
    if (a.eligibility.eligible !== b.eligibility.eligible) return a.eligibility.eligible ? -1 : 1;
    if (a.scores.opportunityScore !== b.scores.opportunityScore) return b.scores.opportunityScore - a.scores.opportunityScore;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Estimates scaled to a funding amount. Conservative rounding: gains down, downside up. */
export function estimateForAmount(
  opportunity: Pick<OpportunityInput, 'requiredCapitalChf' | 'expectedNetProfitChf' | 'downsideChf'> & { scores: Pick<OpportunityScores, 'riskAdjustedProfitChf'> },
  amountChf: Rappen,
): { expectedNetProfitChf: Rappen; riskAdjustedProfitChf: Rappen; downsideChf: Rappen } {
  if (amountChf === ZERO_CHF) return { expectedNetProfitChf: ZERO_CHF, riskAdjustedProfitChf: ZERO_CHF, downsideChf: ZERO_CHF };
  const whole = chfToDecimal(opportunity.requiredCapitalChf);
  const part = chfToDecimal(amountChf);
  return {
    expectedNetProfitChf: prorateChf(opportunity.expectedNetProfitChf, part, whole, 'floor'),
    riskAdjustedProfitChf: prorateChf(opportunity.scores.riskAdjustedProfitChf, part, whole, 'floor'),
    downsideChf: prorateChf(opportunity.downsideChf, part, whole, 'ceil'),
  };
}

/** confidence * profit - (1 - confidence) * downside, rounded down. Confidence is a score, not a calibrated probability. */
export function riskAdjustedProfit(expectedNetProfitChf: Rappen, downsideChf: Rappen, confidenceScore: number): Rappen {
  const confidence = Decimal.from(confidenceScore);
  const upside = chfToDecimal(expectedNetProfitChf).times(confidence);
  const adverse = chfToDecimal(downsideChf).times(Decimal.ONE.minus(confidence));
  return chfRounded(upside.minus(adverse), 'floor');
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
