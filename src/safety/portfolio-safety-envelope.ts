import type { PortfolioSnapshot, PositionView } from '../capital/capital-types.js';
import {
  nonNegativeChf,
  ratioBp,
  rappen,
  sumChf,
  type Rappen,
} from '../money/money.js';
import { hashOf } from '../persistence/canonical-json.js';

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

const HEX64 = /^[0-9a-f]{64}$/;
const DAY_ID = /^\d{4}-\d{2}-\d{2}$/;

function fail(code: PortfolioSafetyError['code'], message: string): never {
  throw new PortfolioSafetyError(code, message);
}

function canonicalMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function requireRappen(value: unknown, code: PortfolioSafetyError['code'], label: string): asserts value is Rappen {
  if (typeof value !== 'bigint') fail(code, label + ' must be bigint Rappen');
}

function requireNonNegativeRappen(value: unknown, code: PortfolioSafetyError['code'], label: string): asserts value is Rappen {
  requireRappen(value, code, label);
  if (value < 0n) fail(code, label + ' must be non-negative');
}

function requirePositiveSafeInt(value: unknown, code: PortfolioSafetyError['code'], label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(code, label + ' must be a positive safe integer');
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function validatePolicy(policy: PortfolioSafetyPolicy): void {
  if (!policy || policy.version !== PORTFOLIO_SAFETY_POLICY_VERSION) {
    fail('INVALID_POLICY', 'unsupported safety policy version');
  }
  for (const [label, value] of [
    ['maxAdjustedDailyLossChf', policy.maxAdjustedDailyLossChf],
    ['maxRealizedTradingLossChf', policy.maxRealizedTradingLossChf],
    ['maxIntradayDrawdownChf', policy.maxIntradayDrawdownChf],
  ] as const) {
    requireNonNegativeRappen(value, 'INVALID_POLICY', label);
  }
  for (const [label, value] of [
    ['maxAdjustedDailyLossBp', policy.maxAdjustedDailyLossBp],
    ['maxIntradayDrawdownBp', policy.maxIntradayDrawdownBp],
    ['maxGrossExposureBp', policy.maxGrossExposureBp],
    ['maxSinglePositionExposureBp', policy.maxSinglePositionExposureBp],
    ['maxOpenPositions', policy.maxOpenPositions],
  ] as const) {
    requirePositiveSafeInt(value, 'INVALID_POLICY', label);
  }
  if (policy.requireCompleteFinancialPricing !== true) {
    fail('INVALID_POLICY', 'V1 requires complete financial pricing');
  }
}

function validateDay(day: RiskDaySummary, portfolio: PortfolioSnapshot): void {
  if (!day || day.version !== RISK_DAY_SUMMARY_VERSION) fail('INVALID_DAY', 'unsupported risk-day version');
  if (!DAY_ID.test(day.dayId)) fail('INVALID_DAY', 'dayId must be YYYY-MM-DD');
  const startMs = canonicalMs(day.dayStartedAt);
  const asOfMs = canonicalMs(day.asOf);
  if (startMs === null || asOfMs === null || startMs > asOfMs) {
    fail('INVALID_DAY', 'risk-day timestamps are invalid');
  }
  for (const [label, value] of [
    ['startNetWorthChf', day.startNetWorthChf],
    ['peakAdjustedNetWorthChf', day.peakAdjustedNetWorthChf],
    ['netExternalFlowsTodayChf', day.netExternalFlowsTodayChf],
    ['realizedTradingPnlTodayChf', day.realizedTradingPnlTodayChf],
  ] as const) {
    requireRappen(value, 'INVALID_DAY', label);
  }
  if (day.startNetWorthChf <= 0n) fail('INVALID_DAY', 'startNetWorthChf must be positive');
  if (day.peakAdjustedNetWorthChf <= 0n) fail('INVALID_DAY', 'peakAdjustedNetWorthChf must be positive');
  if (!HEX64.test(day.sourceLedgerHeadHash) || !HEX64.test(day.sourceFingerprint)) {
    fail('INVALID_DAY', 'risk-day source hashes must be lowercase sha256 hex');
  }
  requireRappen(portfolio.capital.totalNetWorthChf, 'INVALID_PORTFOLIO', 'totalNetWorthChf');
  const adjustedCurrent = rappen(portfolio.capital.totalNetWorthChf - day.netExternalFlowsTodayChf);
  if (day.peakAdjustedNetWorthChf < day.startNetWorthChf || day.peakAdjustedNetWorthChf < adjustedCurrent) {
    fail('INVALID_DAY', 'peakAdjustedNetWorthChf is inconsistent with day start/current adjusted net worth');
  }
}

function validatePosition(position: PositionView): void {
  if (!position || typeof position !== 'object') fail('INVALID_PORTFOLIO', 'position must be an object');
  if (typeof position.brokerId !== 'string' || position.brokerId.trim() === '') fail('INVALID_PORTFOLIO', 'position brokerId is required');
  if (typeof position.instrumentId !== 'string' || position.instrumentId.trim() === '') fail('INVALID_PORTFOLIO', 'position instrumentId is required');
  if (typeof position.isOpen !== 'boolean') fail('INVALID_PORTFOLIO', 'position isOpen must be boolean');
  if (!['live', 'stale', 'not_connected'].includes(position.priceStatus)) fail('INVALID_PORTFOLIO', 'position priceStatus is invalid');
  if (position.marketValueChf !== null) requireNonNegativeRappen(position.marketValueChf, 'INVALID_PORTFOLIO', 'position marketValueChf');
}

function validatePortfolio(portfolio: PortfolioSnapshot, day: RiskDaySummary): void {
  if (!portfolio || typeof portfolio !== 'object' || !portfolio.capital || !Array.isArray(portfolio.positions)) {
    fail('INVALID_PORTFOLIO', 'portfolio snapshot is malformed');
  }
  const timestampMs = canonicalMs(portfolio.capital.timestamp);
  if (timestampMs === null || portfolio.capital.timestamp !== day.asOf) {
    fail('INVALID_PORTFOLIO', 'portfolio timestamp must equal risk-day asOf');
  }
  requireRappen(portfolio.capital.totalNetWorthChf, 'INVALID_PORTFOLIO', 'totalNetWorthChf');
  requireNonNegativeRappen(portfolio.capital.capitalShortfallChf, 'INVALID_PORTFOLIO', 'capitalShortfallChf');

  if (!portfolio.capital.dataStatus || !Array.isArray(portfolio.capital.dataStatus.unpricedPositions) || !Array.isArray(portfolio.capital.dataStatus.stalePositions)) {
    fail('INVALID_PORTFOLIO', 'portfolio data status is malformed');
  }
  if (new Set(portfolio.capital.dataStatus.unpricedPositions).size !== portfolio.capital.dataStatus.unpricedPositions.length) {
    fail('INVALID_PORTFOLIO', 'unpricedPositions contains duplicates');
  }
  if (new Set(portfolio.capital.dataStatus.stalePositions).size !== portfolio.capital.dataStatus.stalePositions.length) {
    fail('INVALID_PORTFOLIO', 'stalePositions contains duplicates');
  }

  const ids = new Set<string>();
  for (const position of portfolio.positions) {
    validatePosition(position);
    const key = position.brokerId + ':' + position.instrumentId;
    if (ids.has(key)) fail('INVALID_PORTFOLIO', 'duplicate position identity ' + key);
    ids.add(key);
  }
}

function validateKillSwitch(state: KillSwitchState, asOf: string): void {
  if (!state || state.version !== PORTFOLIO_KILL_SWITCH_VERSION) {
    fail('INVALID_KILL_SWITCH', 'unsupported kill-switch version');
  }
  if (state.status !== 'ARMED' && state.status !== 'TRIPPED') fail('INVALID_KILL_SWITCH', 'kill-switch status is invalid');
  if (!Array.isArray(state.reasons) || new Set(state.reasons).size !== state.reasons.length || state.reasons.some((r) => typeof r !== 'string' || r.trim() === '')) {
    fail('INVALID_KILL_SWITCH', 'kill-switch reasons are invalid');
  }
  if (state.status === 'ARMED') {
    if (state.tripId !== null || state.trippedAt !== null || state.reasons.length !== 0 || state.triggeringDecisionFingerprint !== null) {
      fail('INVALID_KILL_SWITCH', 'armed kill switch must not carry trip state');
    }
    return;
  }
  if (typeof state.tripId !== 'string' || !/^trip_[0-9a-f]{40}$/.test(state.tripId)) fail('INVALID_KILL_SWITCH', 'tripId is invalid');
  const trippedMs = canonicalMs(state.trippedAt);
  const asOfMs = canonicalMs(asOf)!;
  if (trippedMs === null || trippedMs > asOfMs) fail('INVALID_KILL_SWITCH', 'trippedAt is invalid');
  if (state.reasons.length === 0) fail('INVALID_KILL_SWITCH', 'tripped kill switch requires reasons');
  if (typeof state.triggeringDecisionFingerprint !== 'string' || !HEX64.test(state.triggeringDecisionFingerprint)) {
    fail('INVALID_KILL_SWITCH', 'triggering decision fingerprint is invalid');
  }
}

function normalizedPortfolio(portfolio: PortfolioSnapshot): unknown {
  return {
    ...portfolio,
    capital: {
      ...portfolio.capital,
      dataStatus: {
        ...portfolio.capital.dataStatus,
        unpricedPositions: sortedUnique(portfolio.capital.dataStatus.unpricedPositions),
        stalePositions: sortedUnique(portfolio.capital.dataStatus.stalePositions),
      },
    },
    positions: [...portfolio.positions].sort((a, b) => {
      const ak = a.brokerId + ':' + a.instrumentId;
      const bk = b.brokerId + ':' + b.instrumentId;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    }),
    inventory: [...portfolio.inventory].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)),
  };
}

function normalizedKillSwitch(state: KillSwitchState): unknown {
  return { ...state, reasons: sortedUnique(state.reasons) };
}

function addAlert(
  alerts: SafetyAlertDescriptor[],
  code: SafetyAlertDescriptor['code'],
  severity: SafetyAlertDescriptor['severity'],
  reason: string,
): void {
  if (!alerts.some((alert) => alert.code === code && alert.severity === severity)) {
    alerts.push({ code, severity, reason });
  }
}

export function evaluatePortfolioSafetyEnvelope(
  request: PortfolioSafetyRequest,
): PortfolioSafetyDecision {
  validatePolicy(request.policy);
  validatePortfolio(request.portfolio, request.day);
  validateDay(request.day, request.portfolio);
  validateKillSwitch(request.previousKillSwitch, request.day.asOf);

  const adjustedCurrentNetWorthChf = rappen(
    request.portfolio.capital.totalNetWorthChf - request.day.netExternalFlowsTodayChf,
  );
  const adjustedDailyPnlChf = rappen(adjustedCurrentNetWorthChf - request.day.startNetWorthChf);
  const adjustedDailyLossChf = adjustedDailyPnlChf < 0n ? rappen(-adjustedDailyPnlChf) : rappen(0n);
  const adjustedDailyLossBp =
    adjustedDailyLossChf === 0n ? 0 : ratioBp(adjustedDailyLossChf, request.day.startNetWorthChf, 'ceil');

  const realizedTradingLossChf =
    request.day.realizedTradingPnlTodayChf < 0n
      ? rappen(-request.day.realizedTradingPnlTodayChf)
      : rappen(0n);

  const rawDrawdown = rappen(request.day.peakAdjustedNetWorthChf - adjustedCurrentNetWorthChf);
  const intradayDrawdownChf = nonNegativeChf(rawDrawdown);
  const intradayDrawdownBp =
    intradayDrawdownChf === 0n
      ? 0
      : ratioBp(intradayDrawdownChf, request.day.peakAdjustedNetWorthChf, 'ceil');

  const openPositions = request.portfolio.positions.filter((position) => position.isOpen);
  const dataHoldReasons: string[] = [];
  const capitalData = request.portfolio.capital.dataStatus;
  if (
    openPositions.length > 0 &&
    request.policy.requireCompleteFinancialPricing &&
    capitalData.financialMarketData !== 'complete'
  ) {
    dataHoldReasons.push('financial pricing is incomplete');
  }
  if (
    openPositions.some((position) => position.marketValueChf === null) ||
    openPositions.some((position) => position.priceStatus !== 'live') ||
    capitalData.unpricedPositions.length > 0 ||
    capitalData.stalePositions.length > 0
  ) {
    if (!dataHoldReasons.includes('financial pricing is incomplete')) {
      dataHoldReasons.push('financial pricing is incomplete');
    }
  }

  let grossExposureChf: Rappen | null = null;
  let grossExposureBp: number | null = null;
  let maximumPositionExposureBp: number | null = null;

  if (dataHoldReasons.length === 0) {
    grossExposureChf = sumChf(openPositions.map((position) => position.marketValueChf ?? rappen(0n)));
    if (request.portfolio.capital.totalNetWorthChf > 0n) {
      grossExposureBp =
        grossExposureChf === 0n ? 0 : ratioBp(grossExposureChf, request.portfolio.capital.totalNetWorthChf, 'ceil');
      maximumPositionExposureBp = openPositions.reduce((maximum, position) => {
        const value = position.marketValueChf ?? rappen(0n);
        const bp = value === 0n ? 0 : ratioBp(value, request.portfolio.capital.totalNetWorthChf, 'ceil');
        return Math.max(maximum, bp);
      }, 0);
    }
  }

  const metrics: PortfolioSafetyMetrics = {
    adjustedCurrentNetWorthChf,
    adjustedDailyPnlChf,
    adjustedDailyLossChf,
    adjustedDailyLossBp,
    realizedTradingPnlTodayChf: request.day.realizedTradingPnlTodayChf,
    realizedTradingLossChf,
    intradayDrawdownChf,
    intradayDrawdownBp,
    grossExposureChf,
    grossExposureBp,
    maximumPositionExposureBp,
    openPositionCount: openPositions.length,
  };

  const hardBreachReasons: string[] = [];
  const capacityBlockReasons: string[] = [];
  const alerts: SafetyAlertDescriptor[] = [];

  if (adjustedDailyLossChf >= request.policy.maxAdjustedDailyLossChf) {
    hardBreachReasons.push('adjusted daily loss reached CHF limit');
    addAlert(alerts, 'DAILY_LOSS_LIMIT', 'trip', 'adjusted daily loss reached CHF limit');
  }
  if (adjustedDailyLossBp >= request.policy.maxAdjustedDailyLossBp) {
    hardBreachReasons.push('adjusted daily loss reached bp limit');
    addAlert(alerts, 'DAILY_LOSS_LIMIT', 'trip', 'adjusted daily loss reached bp limit');
  }
  if (realizedTradingLossChf >= request.policy.maxRealizedTradingLossChf) {
    hardBreachReasons.push('realized trading loss reached CHF limit');
    addAlert(alerts, 'REALIZED_LOSS_LIMIT', 'trip', 'realized trading loss reached CHF limit');
  }
  if (intradayDrawdownChf >= request.policy.maxIntradayDrawdownChf) {
    hardBreachReasons.push('intraday drawdown reached CHF limit');
    addAlert(alerts, 'INTRADAY_DRAWDOWN_LIMIT', 'trip', 'intraday drawdown reached CHF limit');
  }
  if (intradayDrawdownBp >= request.policy.maxIntradayDrawdownBp) {
    hardBreachReasons.push('intraday drawdown reached bp limit');
    addAlert(alerts, 'INTRADAY_DRAWDOWN_LIMIT', 'trip', 'intraday drawdown reached bp limit');
  }
  if (request.portfolio.capital.capitalShortfallChf > 0n) {
    hardBreachReasons.push('capital shortfall is positive');
    addAlert(alerts, 'CAPITAL_SHORTFALL', 'trip', 'capital shortfall is positive');
  }
  if (request.portfolio.capital.totalNetWorthChf <= 0n) {
    hardBreachReasons.push('total net worth is non-positive');
    addAlert(alerts, 'NON_POSITIVE_NET_WORTH', 'trip', 'total net worth is non-positive');
  }

  if (openPositions.length > request.policy.maxOpenPositions) {
    hardBreachReasons.push('open position count exceeds limit');
    addAlert(alerts, 'OPEN_POSITION_LIMIT', 'trip', 'open position count exceeds limit');
  } else if (openPositions.length === request.policy.maxOpenPositions) {
    capacityBlockReasons.push('open position count is at limit');
  }

  if (grossExposureBp !== null) {
    if (grossExposureBp > request.policy.maxGrossExposureBp) {
      hardBreachReasons.push('gross exposure exceeds limit');
      addAlert(alerts, 'GROSS_EXPOSURE_LIMIT', 'trip', 'gross exposure exceeds limit');
    } else if (grossExposureBp === request.policy.maxGrossExposureBp) {
      capacityBlockReasons.push('gross exposure is at limit');
    }
  }
  if (maximumPositionExposureBp !== null) {
    if (maximumPositionExposureBp > request.policy.maxSinglePositionExposureBp) {
      hardBreachReasons.push('single position exposure exceeds limit');
      addAlert(alerts, 'POSITION_EXPOSURE_LIMIT', 'trip', 'single position exposure exceeds limit');
    } else if (maximumPositionExposureBp === request.policy.maxSinglePositionExposureBp) {
      capacityBlockReasons.push('single position exposure is at limit');
    }
  }

  if (dataHoldReasons.length > 0) {
    addAlert(alerts, 'PRICING_DATA_HOLD', 'hold', dataHoldReasons[0]!);
  }

  const sourceFingerprints = {
    portfolio: hashOf(normalizedPortfolio(request.portfolio)),
    riskDay: hashOf(request.day),
    previousKillSwitch: hashOf(normalizedKillSwitch(request.previousKillSwitch)),
    policy: hashOf(request.policy),
  };

  const canonicalHardReasons = sortedUnique(hardBreachReasons);
  const canonicalCapacityReasons = sortedUnique(capacityBlockReasons);
  const canonicalDataReasons = sortedUnique(dataHoldReasons);
  const tripTriggerFingerprint = hashOf({
    engineVersion: PORTFOLIO_SAFETY_ENVELOPE_VERSION,
    asOf: request.day.asOf,
    sourceFingerprints,
    metrics,
    hardBreachReasons: canonicalHardReasons,
  });

  let killSwitch: KillSwitchState;
  if (request.previousKillSwitch.status === 'TRIPPED') {
    killSwitch = {
      ...request.previousKillSwitch,
      reasons: [...request.previousKillSwitch.reasons],
    };
    addAlert(alerts, 'KILL_SWITCH_LATCHED', 'trip', 'previously tripped kill switch remains latched');
  } else if (canonicalHardReasons.length > 0) {
    killSwitch = {
      version: PORTFOLIO_KILL_SWITCH_VERSION,
      status: 'TRIPPED',
      tripId: 'trip_' + tripTriggerFingerprint.slice(0, 40),
      trippedAt: request.day.asOf,
      reasons: canonicalHardReasons,
      triggeringDecisionFingerprint: tripTriggerFingerprint,
    };
  } else {
    killSwitch = {
      version: PORTFOLIO_KILL_SWITCH_VERSION,
      status: 'ARMED',
      tripId: null,
      trippedAt: null,
      reasons: [],
      triggeringDecisionFingerprint: null,
    };
  }

  const state: PortfolioSafetyState =
    killSwitch.status === 'TRIPPED'
      ? 'TRIPPED'
      : canonicalDataReasons.length > 0
        ? 'DATA_HOLD'
        : canonicalCapacityReasons.length > 0
          ? 'CAPACITY_BLOCK'
          : 'NORMAL';

  const canonicalAlerts = [...alerts].sort((a, b) => {
    const ak = a.code + '|' + a.severity + '|' + a.reason;
    const bk = b.code + '|' + b.severity + '|' + b.reason;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const inputFingerprint = hashOf({
    engineVersion: PORTFOLIO_SAFETY_ENVELOPE_VERSION,
    asOf: request.day.asOf,
    sourceFingerprints,
    metrics,
    state,
    hardBreachReasons: canonicalHardReasons,
    capacityBlockReasons: canonicalCapacityReasons,
    dataHoldReasons: canonicalDataReasons,
    alerts: canonicalAlerts,
    killSwitch: normalizedKillSwitch(killSwitch),
  });

  return {
    decisionId: 'pse_' + inputFingerprint.slice(0, 40),
    engineVersion: PORTFOLIO_SAFETY_ENVELOPE_VERSION,
    inputFingerprint,
    asOf: request.day.asOf,
    state,
    canIncreaseRisk: state === 'NORMAL',
    canReduceRisk: true,
    liveOrderAllowed: false,
    physicalPurchaseAllowed: false,
    metrics,
    hardBreachReasons: canonicalHardReasons,
    capacityBlockReasons: canonicalCapacityReasons,
    dataHoldReasons: canonicalDataReasons,
    alerts: canonicalAlerts,
    killSwitch,
    sourceFingerprints,
  };
}

export function verifyPortfolioSafetyDecision(
  request: PortfolioSafetyRequest,
  decision: PortfolioSafetyDecision,
): void {
  if (!decision || typeof decision !== 'object') fail('INVALID_DECISION', 'safety decision is missing');
  const expected = evaluatePortfolioSafetyEnvelope(request);
  if (hashOf(expected) !== hashOf(decision)) {
    fail('INVALID_DECISION', 'safety decision does not match its source request');
  }
}
