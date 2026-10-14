import type { PortfolioSnapshot } from '../capital/capital-types.js';
import type { Rappen } from '../money/money.js';

export const PORTFOLIO_SAFETY_ENVELOPE_VERSION = 'portfolio-safety-envelope:v1' as const;
export const PORTFOLIO_SAFETY_POLICY_VERSION = 'portfolio-safety-policy:v1' as const;
export const RISK_DAY_SUMMARY_VERSION = 'risk-day-summary:v1' as const;
export const PORTFOLIO_KILL_SWITCH_VERSION = 'portfolio-kill-switch:v1' as const;

export type PortfolioSafetyState = 'NORMAL' | 'DATA_HOLD' | 'CAPACITY_BLOCK' | 'TRIPPED';
export type KillSwitchStatus = 'ARMED' | 'TRIPPED';

export interface PortfolioSafetyPolicy {
  version: typeof PORTFOLIO_SAFETY_POLICY_VERSION;
  maxAdjustedDailyLossChf: Rappen;
  maxAdjustedDailyLossBp: number;
  maxRealizedTradingLossChf: Rappen;
  maxIntradayDrawdownChf: Rappen;
  maxIntradayDrawdownBp: number;
  maxGrossExposureBp: number;
  maxSinglePositionExposureBp: number;
  maxOpenPositions: number;
  requireCompleteFinancialPricing: true;
}

export interface RiskDaySummary {
  version: typeof RISK_DAY_SUMMARY_VERSION;
  dayId: string;
  dayStartedAt: string;
  asOf: string;
  startNetWorthChf: Rappen;
  peakAdjustedNetWorthChf: Rappen;
  netExternalFlowsTodayChf: Rappen;
  realizedTradingPnlTodayChf: Rappen;
  sourceLedgerHeadHash: string;
  sourceFingerprint: string;
}

export interface KillSwitchState {
  version: typeof PORTFOLIO_KILL_SWITCH_VERSION;
  status: KillSwitchStatus;
  tripId: string | null;
  trippedAt: string | null;
  reasons: readonly string[];
  triggeringDecisionFingerprint: string | null;
}

export interface PortfolioSafetyRequest {
  portfolio: PortfolioSnapshot;
  day: RiskDaySummary;
  previousKillSwitch: KillSwitchState;
  policy: PortfolioSafetyPolicy;
}

export interface PortfolioSafetyMetrics {
  adjustedCurrentNetWorthChf: Rappen;
  adjustedDailyPnlChf: Rappen;
  adjustedDailyLossChf: Rappen;
  adjustedDailyLossBp: number;
  realizedTradingPnlTodayChf: Rappen;
  realizedTradingLossChf: Rappen;
  intradayDrawdownChf: Rappen;
  intradayDrawdownBp: number;
  grossExposureChf: Rappen | null;
  grossExposureBp: number | null;
  maximumPositionExposureBp: number | null;
  openPositionCount: number;
}

export interface SafetyAlertDescriptor {
  code:
    | 'DAILY_LOSS_LIMIT'
    | 'REALIZED_LOSS_LIMIT'
    | 'INTRADAY_DRAWDOWN_LIMIT'
    | 'GROSS_EXPOSURE_LIMIT'
    | 'POSITION_EXPOSURE_LIMIT'
    | 'OPEN_POSITION_LIMIT'
    | 'CAPITAL_SHORTFALL'
    | 'NON_POSITIVE_NET_WORTH'
    | 'PRICING_DATA_HOLD'
    | 'KILL_SWITCH_LATCHED';
  severity: 'hold' | 'trip';
  reason: string;
}

export interface PortfolioSafetyDecision {
  decisionId: string;
  engineVersion: typeof PORTFOLIO_SAFETY_ENVELOPE_VERSION;
  inputFingerprint: string;
  asOf: string;
  state: PortfolioSafetyState;
  canIncreaseRisk: boolean;
  canReduceRisk: true;
  liveOrderAllowed: false;
  physicalPurchaseAllowed: false;
  metrics: PortfolioSafetyMetrics;
  hardBreachReasons: string[];
  capacityBlockReasons: string[];
  dataHoldReasons: string[];
  alerts: SafetyAlertDescriptor[];
  killSwitch: KillSwitchState;
  sourceFingerprints: {
    portfolio: string;
    riskDay: string;
    previousKillSwitch: string;
    policy: string;
  };
}

export class PortfolioSafetyError extends Error {
  override readonly name = 'PortfolioSafetyError';
  constructor(
    readonly code:
      | 'INVALID_PORTFOLIO'
      | 'INVALID_DAY'
      | 'INVALID_KILL_SWITCH'
      | 'INVALID_POLICY'
      | 'INVALID_DECISION',
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

export function evaluatePortfolioSafetyEnvelope(
  _request: PortfolioSafetyRequest,
): PortfolioSafetyDecision {
  throw new Error('O15 portfolio safety envelope not implemented');
}

export function verifyPortfolioSafetyDecision(
  _request: PortfolioSafetyRequest,
  _decision: PortfolioSafetyDecision,
): void {
  throw new Error('O15 portfolio safety verifier not implemented');
}
