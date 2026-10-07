// Capital Reallocation: detects capital bound in a holding that is expected to do worse than an
// opportunity which cannot be funded from available cash, and PROPOSES a partial switch.
//
// Safeguards ("never liquidate on a higher predicted return alone"):
//  - the holding needs an explicit, connected forward forecast; NEXUS never assumes a holding is worse
//  - the holding needs a fresh market price (no fake valuation)
//  - the opportunity side uses the RISK-ADJUSTED profit, minus all exit costs (commission, spread, tax)
//  - both sides are compared over the same horizon, including the settlement delay
//  - the net advantage must clear an absolute and a relative hurdle
//  - additional risk, confidence and score limits apply
//  - only a capped fraction of a position may be moved per proposal
//  - every reallocation requires explicit human approval

import { Decimal } from '../money/decimal.js';
import {
  addChf,
  applyBp,
  BASIS_POINTS,
  chfRounded,
  chfToDecimal,
  formatChf,
  maxChf,
  minChf,
  prorateChf,
  rappen,
  subChf,
  ZERO_CHF,
  type Rappen,
} from '../money/money.js';
import { estimateForAmount, rankOpportunities } from '../opportunities/opportunity-engine.js';
import type { EstimateSource, Opportunity } from '../opportunities/opportunity-types.js';
import { FUNDABLE_STATUSES, type AllocationProposal } from './capital-allocator.js';
import type { DataStatus, PortfolioSnapshot, PositionView } from './capital-types.js';
import { positionKey } from './portfolio.js';

/** Forward-looking expectation for an existing holding (from quant / AI committee), with provenance. */
export interface HoldingForecast {
  brokerId: string;
  instrumentId: string;
  /** Expected return over horizonDays, basis points (may be negative). */
  expectedReturnBp: number;
  horizonDays: number;
  riskScore: number;
  source: EstimateSource;
  dataStatus: DataStatus;
  asOf: string;
}

export interface ExitCostModel {
  commissionChf: Rappen;
  spreadBp: number;
  /** Tax on realized gains (0 for Swiss private investors in most cases; set explicitly). */
  taxOnGainBp: number;
}

export interface ReallocationPolicy {
  /** Max share of a single position that one proposal may reduce. */
  maxReductionBpOfPosition: number;
  maxReallocationBpOfNetWorth: number;
  minNetAdvantageChf: Rappen;
  minNetAdvantageBpOfAmount: number;
  minOpportunityConfidence: number;
  minOpportunityScore: number;
  /** opportunity.riskScore - holding.riskScore may not exceed this. */
  maxAdditionalRiskScore: number;
  /** Used (with a warning) when an instrument's settlement period is unknown. */
  assumedSettlementDaysIfUnknown: number;
}

export interface ReallocationProposal {
  id: string;
  createdAt: string;
  status: 'proposed';
  requiresHumanApproval: true;
  from: {
    brokerId: string;
    instrumentId: string;
    reduceByChf: Rappen;
    /** Indicative only; the broker fill decides the actual quantity. */
    estimatedQuantity: Decimal;
    positionMarketValueChf: Rappen;
    settlementDays: number;
  };
  to: { opportunityId: string; name: string; amountChf: Rappen };
  economics: {
    exitCosts: { commissionChf: Rappen; spreadChf: Rappen; taxChf: Rappen; totalChf: Rappen };
    /** Share of the unrealized P&L that the reduction would realize (negative = realizes a loss). */
    realizedPnlChf: Rappen;
    keepExpectedChf: Rappen;
    switchExpectedChf: Rappen;
    netAdvantageChf: Rappen;
    requiredAdvantageChf: Rappen;
    horizonDays: number;
  };
  risk: { holdingRiskScore: number; opportunityRiskScore: number; opportunityDownsideChf: Rappen };
  rationale: string[];
  warnings: string[];
}

export interface RejectedReallocation {
  opportunityId: string;
  position?: string;
  reasons: string[];
}

export function proposeReallocations(input: {
  at: string;
  newId: () => string;
  snapshot: PortfolioSnapshot;
  opportunities: readonly Opportunity[];
  forecasts: readonly HoldingForecast[];
  exitCosts: ExitCostModel | ((position: PositionView) => ExitCostModel);
  policy: ReallocationPolicy;
  /** If given, opportunity amounts already funded from cash are not reallocated again. */
  allocation?: AllocationProposal;
}): { proposals: ReallocationProposal[]; rejected: RejectedReallocation[] } {
  const { snapshot, policy } = input;
  const netWorth = maxChf(snapshot.capital.totalNetWorthChf, ZERO_CHF);
  const maxPerProposal = applyBp(netWorth, policy.maxReallocationBpOfNetWorth, 'floor');
  const exitCostsFor = typeof input.exitCosts === 'function' ? input.exitCosts : () => input.exitCosts as ExitCostModel;
  const funded = new Map((input.allocation?.allocations ?? []).map((a) => [a.opportunityId, a.amountChf]));

  const openPositions = snapshot.positions.filter((p) => p.isOpen);
  const forecastFor = (p: PositionView) => input.forecasts.find((f) => f.brokerId === p.brokerId && f.instrumentId === p.instrumentId);
  const reducible = new Map<string, Rappen>();
  for (const p of openPositions) {
    if (p.marketValueChf !== null) reducible.set(positionKey(p.brokerId, p.instrumentId), applyBp(p.marketValueChf, policy.maxReductionBpOfPosition, 'floor'));
  }
  // Weakest expected daily return first; positions without forecast last (they are rejected anyway).
  const candidates = [...openPositions].sort((a, b) => dailyReturn(forecastFor(a)) - dailyReturn(forecastFor(b)) || compareKey(a, b));

  const proposals: ReallocationProposal[] = [];
  const rejected: RejectedReallocation[] = [];

  for (const opportunity of rankOpportunities(input.opportunities)) {
    const opportunityReasons: string[] = [];
    if (!FUNDABLE_STATUSES.includes(opportunity.status)) opportunityReasons.push('status "' + opportunity.status + '" is not fundable');
    if (!opportunity.eligibility.eligible) opportunityReasons.push(...opportunity.eligibility.reasons);
    if (opportunity.confidenceScore < policy.minOpportunityConfidence) {
      opportunityReasons.push('confidence score ' + opportunity.confidenceScore + ' below minimum ' + policy.minOpportunityConfidence + ' — a higher predicted return alone is not enough');
    }
    if (opportunity.scores.opportunityScore < policy.minOpportunityScore) {
      opportunityReasons.push('opportunity score ' + opportunity.scores.opportunityScore + ' below minimum ' + policy.minOpportunityScore);
    }
    if (opportunityReasons.length > 0) {
      rejected.push({ opportunityId: opportunity.id, reasons: opportunityReasons });
      continue;
    }

    const target = opportunity.sizing.kind === 'scalable' ? opportunity.sizing.maxCapitalChf : opportunity.requiredCapitalChf;
    let need = subChf(target, funded.get(opportunity.id) ?? ZERO_CHF);

    for (const position of candidates) {
      if (need <= 0n) break;
      const key = positionKey(position.brokerId, position.instrumentId);
      const forecast = forecastFor(position);
      const reasons: string[] = [];
      const reject = () => rejected.push({ opportunityId: opportunity.id, position: key, reasons });

      if (position.marketValueChf === null) reasons.push('DATA NOT CONNECTED: no fresh market price for the holding (' + position.priceStatus + ')');
      if (!forecast) reasons.push('no forward forecast for the holding; NEXUS does not assume a holding is worse');
      else if (forecast.dataStatus !== 'connected') reasons.push('holding forecast is ' + forecast.dataStatus);
      if (position.marketValueChf === null || !forecast || reasons.length > 0) {
        reject();
        continue;
      }
      if (opportunity.riskScore - forecast.riskScore > policy.maxAdditionalRiskScore) {
        reasons.push('additional risk ' + (opportunity.riskScore - forecast.riskScore).toFixed(2) + ' exceeds ' + policy.maxAdditionalRiskScore);
        reject();
        continue;
      }

      // Self-funding sizing: the gross reduction must cover the funded amount PLUS all exit costs,
      // and stay within the reduction cap. Exit costs grow with the sold amount, so the costs of selling
      // the full cap are an upper bound for any smaller sale.
      const marketValue = position.marketValueChf;
      const costs = exitCostsFor(position);
      const unrealized = subChf(marketValue, position.costBasisChf);
      const exitCostsOf = (gross: Rappen) => {
        const realizedPnlChf = prorateChf(unrealized, chfToDecimal(gross), chfToDecimal(marketValue), 'half_even');
        const spreadChf = applyBp(gross, costs.spreadBp, 'ceil');
        const taxChf = realizedPnlChf > 0n ? applyBp(realizedPnlChf, costs.taxOnGainBp, 'ceil') : ZERO_CHF;
        return { realizedPnlChf, commissionChf: costs.commissionChf, spreadChf, taxChf, totalChf: addChf(costs.commissionChf, spreadChf, taxChf) };
      };
      const cap = minChf(reducible.get(key) ?? ZERO_CHF, maxPerProposal);
      const costsAtCap = exitCostsOf(cap);
      let fund = minChf(need, subChf(cap, costsAtCap.totalChf));
      if (opportunity.sizing.kind === 'scalable') {
        fund = fund > 0n ? rappen(fund - (fund % opportunity.sizing.lotSizeChf)) : ZERO_CHF;
        if (fund < opportunity.sizing.minTicketChf) reasons.push('net proceeds within the reduction limits are below the minimum ticket');
      } else if (fund < opportunity.requiredCapitalChf) {
        reasons.push('fixed ticket cannot be funded within the reduction limits after exit costs');
      }
      if (reasons.length > 0 || fund <= 0n) {
        if (reasons.length === 0) reasons.push('nothing left to move from this position');
        reject();
        continue;
      }
      const reduceBy = minChf(cap, addChf(fund, costsAtCap.totalChf));
      const exit = exitCostsOf(reduceBy);

      const warnings: string[] = ['Expected returns are estimates; confidence scores are not calibrated probabilities'];
      let settlementDays = position.settlementDays;
      if (settlementDays === null) {
        settlementDays = policy.assumedSettlementDaysIfUnknown;
        warnings.push('Settlement period unknown, assumed T+' + settlementDays);
      }
      if (exit.realizedPnlChf < 0n) warnings.push('Realizes a loss of ' + formatChf(exit.realizedPnlChf) + ' CHF on the holding');

      // Both sides over the same horizon: the opportunity's holding period plus the settlement delay.
      const horizonDays = opportunity.expectedHoldingDays + settlementDays;
      const keepExpected = chfRounded(
        chfToDecimal(reduceBy)
          .times(forecast.expectedReturnBp)
          .times(horizonDays)
          .dividedBy(Decimal.from(BASIS_POINTS).times(forecast.horizonDays), 2, 'half_even'),
        'half_even',
      );
      const estimate = estimateForAmount(opportunity, fund);
      const switchExpected = subChf(estimate.riskAdjustedProfitChf, exit.totalChf);
      const netAdvantage = subChf(switchExpected, keepExpected);
      const requiredAdvantage = maxChf(policy.minNetAdvantageChf, applyBp(fund, policy.minNetAdvantageBpOfAmount, 'ceil'));

      if (netAdvantage < requiredAdvantage) {
        reasons.push('net advantage ' + formatChf(netAdvantage) + ' CHF is below the required ' + formatChf(requiredAdvantage) + ' CHF after exit costs');
        reject();
        continue;
      }

      proposals.push({
        id: input.newId(),
        createdAt: input.at,
        status: 'proposed',
        requiresHumanApproval: true,
        from: {
          brokerId: position.brokerId,
          instrumentId: position.instrumentId,
          reduceByChf: reduceBy,
          estimatedQuantity: position.quantity.times(chfToDecimal(reduceBy)).dividedBy(chfToDecimal(marketValue), 8, 'down'),
          positionMarketValueChf: marketValue,
          settlementDays,
        },
        to: { opportunityId: opportunity.id, name: opportunity.name, amountChf: fund },
        economics: {
          exitCosts: { commissionChf: exit.commissionChf, spreadChf: exit.spreadChf, taxChf: exit.taxChf, totalChf: exit.totalChf },
          realizedPnlChf: exit.realizedPnlChf,
          keepExpectedChf: keepExpected,
          switchExpectedChf: switchExpected,
          netAdvantageChf: netAdvantage,
          requiredAdvantageChf: requiredAdvantage,
          horizonDays,
        },
        risk: { holdingRiskScore: forecast.riskScore, opportunityRiskScore: opportunity.riskScore, opportunityDownsideChf: estimate.downsideChf },
        rationale: [
          'Keep ' + formatChf(reduceBy) + ' CHF in ' + position.instrumentId + ': expected ' + formatChf(keepExpected) + ' CHF over ' + horizonDays + ' days',
          'Sell ' + formatChf(reduceBy) + ' CHF (exit costs ' + formatChf(exit.totalChf) + ' CHF) and invest ' + formatChf(fund) + ' CHF in ' + opportunity.name +
            ': risk-adjusted ' + formatChf(estimate.riskAdjustedProfitChf) + ' CHF',
          'Net advantage ' + formatChf(netAdvantage) + ' CHF ≥ required ' + formatChf(requiredAdvantage) + ' CHF; additional risk within limit',
        ],
        warnings,
      });
      reducible.set(key, subChf(reducible.get(key) ?? ZERO_CHF, reduceBy));
      need = subChf(need, fund);
      if (opportunity.sizing.kind === 'fixed') break;
    }
  }

  return { proposals, rejected };
}

function dailyReturn(forecast: HoldingForecast | undefined): number {
  return forecast ? forecast.expectedReturnBp / forecast.horizonDays : Number.POSITIVE_INFINITY;
}

function compareKey(a: PositionView, b: PositionView): number {
  const ka = positionKey(a.brokerId, a.instrumentId);
  const kb = positionKey(b.brokerId, b.instrumentId);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
