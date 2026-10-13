// Capital Allocator: turns available capital + ranked opportunities into an allocation PROPOSAL.
// It never executes anything. The proposal must pass the independent capital risk gate
// (risk-engine.ts) and, above the policy thresholds, an explicit human approval.
//
// Deterministic greedy fill: opportunities in score order, each funded up to the tightest of
//   remaining budget | per-opportunity cap | bucket (concentration) room | opportunity capacity | downside budget.
// Small opportunities with little capacity (e.g. 20 CHF of resale stock) are filled completely and
// the remaining capital flows to the next opportunity, so a high % on a tiny deal never "wins" everything.

import type { AssetClass } from '../contracts.js';
import { applyBp, minChf, rappen, subChf, sumChf, ZERO_CHF, type Rappen } from '../money/money.js';
import { estimateForAmount, rankOpportunities } from '../opportunities/opportunity-engine.js';
import type { CapitalBucket, Opportunity, OpportunityStatus, OpportunityType } from '../opportunities/opportunity-types.js';
import type { PortfolioSnapshot } from './capital-types.js';

export interface AllocationPolicy {
  /** Share of available capital one proposal may deploy; the rest stays as cash buffer. */
  maxDeploymentBpOfAvailable: number;
  maxPerOpportunityChf: Rappen;
  maxPerOpportunityBpOfNetWorth: number;
  /** Exposure limit per bucket incl. existing holdings. A bucket missing here may not receive capital. */
  maxBucketExposureBpOfNetWorth: Partial<Record<CapitalBucket, number>>;
  /** Sum of the downside of all new allocations. */
  maxNewDownsideBpOfNetWorth: number;
  minOpportunityScore: number;
  minConfidenceScore: number;
  maxRiskScore: number;
  /** Allocations at or above either threshold require explicit human approval. */
  humanApproval: { thresholdChf: Rappen; thresholdBpOfNetWorth: number };
}

export interface ProposedAllocation {
  opportunityId: string;
  name: string;
  type: OpportunityType;
  bucket: CapitalBucket;
  amountChf: Rappen;
  expectedNetProfitChf: Rappen;
  riskAdjustedProfitChf: Rappen;
  downsideChf: Rappen;
  opportunityScore: number;
  requiresHumanApproval: boolean;
  rationale: string[];
}

export interface SkippedOpportunity {
  opportunityId: string;
  reasons: string[];
}

export type ExposureBucket = CapitalBucket | 'unclassified';

export interface AllocationProposal {
  id: string;
  createdAt: string;
  status: 'proposed';
  basis: {
    stateTimestamp: string;
    netWorthChf: Rappen;
    availableCapitalChf: Rappen;
    safetyReserveChf: Rappen;
  };
  budgetChf: Rappen;
  allocatedChf: Rappen;
  /** Available capital that stays in cash after this proposal (on top of the safety reserve). */
  cashKeptChf: Rappen;
  allocations: ProposedAllocation[];
  skipped: SkippedOpportunity[];
  exposureBeforeChf: Record<ExposureBucket, Rappen>;
  requiresHumanApproval: boolean;
  warnings: string[];
}

export const FUNDABLE_STATUSES: readonly OpportunityStatus[] = ['discovered', 'research', 'approved'];

const ASSET_CLASS_BUCKET: Record<AssetClass, CapitalBucket> = {
  stock: 'equities',
  etf: 'equities',
  index: 'equities',
  crypto: 'crypto',
  forex: 'forex',
  commodity: 'commodities',
  future: 'derivatives',
};

/** Current exposure per bucket: open positions at carrying value, inventory at cost. */
export function currentExposure(snapshot: PortfolioSnapshot): Record<ExposureBucket, Rappen> {
  const exposure: Record<ExposureBucket, bigint> = {
    equities: 0n,
    crypto: 0n,
    forex: 0n,
    commodities: 0n,
    derivatives: 0n,
    physical_trade: 0n,
    business: 0n,
    unclassified: 0n,
  };
  for (const position of snapshot.positions) {
    if (!position.isOpen) continue;
    const bucket: ExposureBucket = position.assetClass === null ? 'unclassified' : ASSET_CLASS_BUCKET[position.assetClass];
    exposure[bucket] += position.carryingValueChf;
  }
  for (const item of snapshot.inventory) exposure.physical_trade += item.costBasisChf;
  return Object.fromEntries(Object.entries(exposure).map(([k, v]) => [k, rappen(v)])) as Record<ExposureBucket, Rappen>;
}

export function proposeAllocation(input: {
  id: string;
  at: string;
  snapshot: PortfolioSnapshot;
  opportunities: readonly Opportunity[];
  policy: AllocationPolicy;
}): AllocationProposal {
  const { snapshot, policy } = input;
  const capital = snapshot.capital;
  const netWorth = capital.totalNetWorthChf > 0n ? capital.totalNetWorthChf : ZERO_CHF;
  const warnings: string[] = [];

  const budget = applyBp(capital.availableCapitalChf, policy.maxDeploymentBpOfAvailable, 'floor');
  const perOpportunityCap = minChf(policy.maxPerOpportunityChf, applyBp(netWorth, policy.maxPerOpportunityBpOfNetWorth, 'floor'));
  const downsideBudget = applyBp(netWorth, policy.maxNewDownsideBpOfNetWorth, 'floor');
  const approvalThreshold = minChf(policy.humanApproval.thresholdChf, applyBp(netWorth, policy.humanApproval.thresholdBpOfNetWorth, 'floor'));
  const exposure = currentExposure(snapshot);

  if (capital.capitalShortfallChf > 0n) warnings.push('Safety reserve shortfall of ' + capital.capitalShortfallChf + ' Rappen: nothing can be allocated');
  if (capital.dataStatus.financialMarketData === 'partial' || capital.dataStatus.financialMarketData === 'not_connected') {
    warnings.push('Financial market data ' + capital.dataStatus.financialMarketData + ': exposure of unpriced positions is taken at cost');
  }
  if (exposure.unclassified > 0n) warnings.push('Positions without instrument metadata are not assigned to any concentration bucket');

  let allocated = ZERO_CHF;
  let downsideUsed = ZERO_CHF;
  const allocatedPerBucket = new Map<CapitalBucket, Rappen>();
  const allocations: ProposedAllocation[] = [];
  const skipped: SkippedOpportunity[] = [];
  const seen = new Set<string>();

  for (const opportunity of rankOpportunities(input.opportunities)) {
    const reasons: string[] = [];
    if (seen.has(opportunity.id)) {
      skipped.push({ opportunityId: opportunity.id, reasons: ['duplicate opportunity id'] });
      continue;
    }
    seen.add(opportunity.id);

    if (!FUNDABLE_STATUSES.includes(opportunity.status)) reasons.push('status "' + opportunity.status + '" is not fundable');
    if (!opportunity.eligibility.eligible) reasons.push(...opportunity.eligibility.reasons);
    if (opportunity.scores.opportunityScore < policy.minOpportunityScore) {
      reasons.push('opportunity score ' + opportunity.scores.opportunityScore + ' below minimum ' + policy.minOpportunityScore);
    }
    if (opportunity.confidenceScore < policy.minConfidenceScore) {
      reasons.push('confidence score ' + opportunity.confidenceScore + ' below minimum ' + policy.minConfidenceScore);
    }
    if (opportunity.riskScore > policy.maxRiskScore) reasons.push('risk score ' + opportunity.riskScore + ' above maximum ' + policy.maxRiskScore);
    const bucketLimitBp = policy.maxBucketExposureBpOfNetWorth[opportunity.bucket];
    if (bucketLimitBp === undefined) reasons.push('bucket "' + opportunity.bucket + '" is not enabled in the allocation policy');
    if (reasons.length > 0 || bucketLimitBp === undefined) {
      skipped.push({ opportunityId: opportunity.id, reasons });
      continue;
    }

    const limits: [string, Rappen][] = [
      ['remaining budget', subChf(budget, allocated)],
      ['per-opportunity cap', perOpportunityCap],
      [
        'bucket limit (' + opportunity.bucket + ')',
        subChf(subChf(applyBp(netWorth, bucketLimitBp, 'floor'), exposure[opportunity.bucket]), allocatedPerBucket.get(opportunity.bucket) ?? ZERO_CHF),
      ],
      ['opportunity capacity', opportunity.sizing.kind === 'scalable' ? opportunity.sizing.maxCapitalChf : opportunity.requiredCapitalChf],
    ];
    const downsideRoom = subChf(downsideBudget, downsideUsed);
    if (opportunity.downsideChf > 0n) {
      // Largest amount whose (pro-rata, rounded-up) downside still fits the remaining downside budget.
      limits.push(['downside budget', rappen((downsideRoom * opportunity.requiredCapitalChf) / opportunity.downsideChf)]);
    }
    const [bindingLimit, cap] = limits.reduce((tightest, limit) => (limit[1] < tightest[1] ? limit : tightest));

    let amount: Rappen;
    if (opportunity.sizing.kind === 'fixed') {
      if (cap < opportunity.requiredCapitalChf) {
        skipped.push({ opportunityId: opportunity.id, reasons: ['fixed ticket of ' + opportunity.requiredCapitalChf + ' Rappen exceeds ' + bindingLimit] });
        continue;
      }
      amount = opportunity.requiredCapitalChf;
    } else {
      const lot = opportunity.sizing.lotSizeChf;
      amount = cap > 0n ? rappen(cap - (cap % lot)) : ZERO_CHF;
      if (amount < opportunity.sizing.minTicketChf) {
        skipped.push({ opportunityId: opportunity.id, reasons: ['below minimum ticket after applying ' + bindingLimit] });
        continue;
      }
    }

    const estimate = estimateForAmount(opportunity, amount);
    if (estimate.downsideChf > downsideRoom) {
      skipped.push({ opportunityId: opportunity.id, reasons: ['downside budget exhausted'] });
      continue;
    }
    if (estimate.riskAdjustedProfitChf <= 0n) {
      skipped.push({ opportunityId: opportunity.id, reasons: ['risk-adjusted profit not positive at fundable size'] });
      continue;
    }

    const requiresHumanApproval = amount >= approvalThreshold;
    allocations.push({
      opportunityId: opportunity.id,
      name: opportunity.name,
      type: opportunity.type,
      bucket: opportunity.bucket,
      amountChf: amount,
      expectedNetProfitChf: estimate.expectedNetProfitChf,
      riskAdjustedProfitChf: estimate.riskAdjustedProfitChf,
      downsideChf: estimate.downsideChf,
      opportunityScore: opportunity.scores.opportunityScore,
      requiresHumanApproval,
      rationale: [
        'Rank by opportunity score ' + opportunity.scores.opportunityScore + ' (capital efficiency ' + opportunity.scores.capitalEfficiencyScore + ')',
        'Sized by ' + bindingLimit,
        ...(requiresHumanApproval ? ['At or above the human-approval threshold of ' + approvalThreshold + ' Rappen'] : []),
      ],
    });
    allocated = rappen(allocated + amount);
    downsideUsed = rappen(downsideUsed + estimate.downsideChf);
    allocatedPerBucket.set(opportunity.bucket, rappen((allocatedPerBucket.get(opportunity.bucket) ?? 0n) + amount));
  }

  return {
    id: input.id,
    createdAt: input.at,
    status: 'proposed',
    basis: {
      stateTimestamp: capital.timestamp,
      netWorthChf: capital.totalNetWorthChf,
      availableCapitalChf: capital.availableCapitalChf,
      safetyReserveChf: capital.safetyReserveChf,
    },
    budgetChf: budget,
    allocatedChf: sumChf(allocations.map((a) => a.amountChf)),
    cashKeptChf: subChf(capital.availableCapitalChf, allocated),
    allocations,
    skipped,
    exposureBeforeChf: exposure,
    requiresHumanApproval: allocations.some((a) => a.requiresHumanApproval),
    warnings,
  };
}
