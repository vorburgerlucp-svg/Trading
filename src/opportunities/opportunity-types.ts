import type { DataStatus } from '../capital/capital-types.js';
import type { Rappen } from '../money/money.js';

/** Financial and real-economy opportunities share one schema so they can be compared and allocated together. */
export type OpportunityType =
  | 'stock'
  | 'etf'
  | 'crypto'
  | 'forex'
  | 'commodity'
  | 'future'
  | 'ipo'
  | 'physical_product'
  | 'reselling'
  | 'wholesale'
  | 'arbitrage'
  | 'dropshipping'
  | 'online_shop'
  | 'business';

/** Concentration buckets used by the allocator's exposure limits. */
export type CapitalBucket = 'equities' | 'crypto' | 'forex' | 'commodities' | 'derivatives' | 'physical_trade' | 'business';

export type OpportunityStatus = 'discovered' | 'research' | 'approved' | 'funded' | 'active' | 'exited' | 'rejected';

export type EstimateSource = 'quant' | 'ai_committee' | 'market_data' | 'manual';

/**
 * fixed: all or nothing at requiredCapitalChf (e.g. one wholesale lot).
 * scalable: any multiple of lotSizeChf between minTicketChf and maxCapitalChf; estimates scale linearly.
 */
export type OpportunitySizing =
  | { kind: 'fixed' }
  | { kind: 'scalable'; minTicketChf: Rappen; maxCapitalChf: Rappen; lotSizeChf: Rappen };

/** What discovery (quant, AI committee, manual research) delivers. Scores are NOT part of the input. */
export interface OpportunityInput {
  id: string;
  type: OpportunityType;
  name: string;

  /** Reference ticket the estimates below refer to. */
  requiredCapitalChf: Rappen;
  sizing: OpportunitySizing;

  /** Base-case profit after ALL known costs (fees, spread, shipping, marketplace, returns, taxes). */
  expectedNetProfitChf: Rappen;
  /** Plausible loss in the adverse case (stop-loss distance, unsold stock written down), as a positive amount. */
  downsideChf: Rappen;
  expectedHoldingDays: number;

  /** 0..1 scores. confidenceScore is an uncalibrated score, NOT a probability. */
  liquidityScore: number;
  confidenceScore: number;
  riskScore: number;
  /** Operational effort: handling, shipping, customer service (0 = none, 1 = very high). */
  effortScore: number;
  regulatoryRiskScore: number;
  /** Hard block (e.g. product not legally sellable, missing licence). */
  regulatoryBlocked?: boolean;

  thesis: string[];
  risks: string[];
  exitPlan: string;

  estimates: {
    source: EstimateSource;
    dataStatus: DataStatus;
    asOf: string;
    /** Stays false until the Learning Engine has calibrated confidence against outcomes. */
    calibrated: boolean;
  };

  links?: { instrumentId?: string; brokerId?: string; productId?: string };
}

export type ScoreComponent = 'return' | 'safety' | 'risk' | 'liquidity' | 'effort' | 'regulatory';

/** Deterministic, explainable scores computed by the opportunity engine. Scores are not money: floats are fine. */
export interface OpportunityScores {
  expectedReturnBp: number;
  /** confidence * profit - (1 - confidence) * downside: penalizes low-confidence, high-downside cases. */
  riskAdjustedProfitChf: Rappen;
  /** Risk-adjusted return per CHF per day (0.01 = 1 % per day). */
  dailyRiskAdjustedReturn: number;
  /** 0..100, capital efficiency (risk-adjusted return per CHF and day, saturating). */
  capitalEfficiencyScore: number;
  /** 0..100 weighted composite. */
  opportunityScore: number;
  components: Record<ScoreComponent, number>;
}

export interface Actor {
  kind: 'human' | 'system';
  id: string;
}

export interface StatusChange {
  from: OpportunityStatus;
  to: OpportunityStatus;
  at: string;
  by: Actor;
  reason: string;
}

export interface Opportunity extends OpportunityInput {
  status: OpportunityStatus;
  bucket: CapitalBucket;
  scores: OpportunityScores;
  /** Hard gates. An ineligible opportunity is never proposed for funding, regardless of score. */
  eligibility: { eligible: boolean; reasons: string[] };
  history: readonly StatusChange[];
}
