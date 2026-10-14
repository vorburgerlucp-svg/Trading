import { describe, expect, it } from 'vitest';
import type { CapitalState, PortfolioSnapshot, PositionView } from '../../src/capital/capital-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { chf, rappen } from '../../src/money/money.js';
import {
  PORTFOLIO_KILL_SWITCH_VERSION,
  PORTFOLIO_SAFETY_ENVELOPE_VERSION,
  PORTFOLIO_SAFETY_POLICY_VERSION,
  RISK_DAY_SUMMARY_VERSION,
  PortfolioSafetyError,
  evaluatePortfolioSafetyEnvelope,
  verifyPortfolioSafetyDecision,
  type KillSwitchState,
  type PortfolioSafetyPolicy,
  type PortfolioSafetyRequest,
  type RiskDaySummary,
} from '../../src/safety/portfolio-safety-envelope.js';

const AS_OF = '2026-10-14T12:00:00.000Z';
const DAY_START = '2026-10-14T00:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function position(
  instrumentId: string,
  marketValueChf = chf(200),
  overrides: Partial<PositionView> = {},
): PositionView {
  return {
    brokerId: 'paper',
    instrumentId,
    symbol: instrumentId,
    assetClass: 'stock',
    isOpen: true,
    quantity: Decimal.from('1'),
    costBasisChf: marketValueChf,
    averageCostChf: Decimal.from('200'),
    priceStatus: 'live',
    lastQuote: {
      instrumentId,
      price: Decimal.from('200'),
      currency: 'CHF',
      asOf: AS_OF,
      source: 'fixture',
    },
    marketValueChf,
    unrealizedPnlChf: chf(0),
    realizedPnlChf: chf(0),
    feesChf: chf(0),
    carryingValueChf: marketValueChf,
    settlementDays: 2,
    ...overrides,
  };
}

function capital(
  totalNetWorthChf = chf(1000),
  overrides: Partial<CapitalState> = {},
): CapitalState {
  return {
    timestamp: AS_OF,
    baseCurrency: 'CHF',
    totalNetWorthChf,
    cash: {
      bankChf: chf(800),
      brokerCashChf: chf(0),
      cryptoCashChf: chf(0),
      physicalCashChf: chf(0),
      totalChf: chf(800),
      unreservedChf: chf(800),
    },
    reservedCapitalChf: chf(0),
    committedCapitalChf: chf(0),
    safetyReserveChf: chf(0),
    availableCapitalChf: chf(800),
    capitalShortfallChf: chf(0),
    financialAssetsChf: chf(200),
    financialAssetsCostChf: chf(200),
    physicalInventoryCostChf: chf(0),
    physicalInventoryMarketValueChf: null,
    receivablesChf: chf(0),
    liabilitiesChf: chf(0),
    investedCapitalChf: chf(200),
    boundCapitalChf: chf(200),
    netContributionsChf: chf(1000),
    pnl: {
      realizedChf: chf(0),
      unrealizedChf: chf(0),
      totalChf: chf(0),
      returnSinceStartBp: 0,
    },
    dataStatus: {
      financialMarketData: 'complete',
      inventoryMarketData: 'not_required',
      unpricedPositions: [],
      stalePositions: [],
    },
    ...overrides,
  };
}

function portfolio(overrides: {
  capital?: CapitalState;
  positions?: PositionView[];
} = {}): PortfolioSnapshot {
  return {
    capital: overrides.capital ?? capital(),
    positions: overrides.positions ?? [position('AAPL')],
    inventory: [],
  };
}

function day(overrides: Partial<RiskDaySummary> = {}): RiskDaySummary {
  return {
    version: RISK_DAY_SUMMARY_VERSION,
    dayId: '2026-10-14',
    dayStartedAt: DAY_START,
    asOf: AS_OF,
    startNetWorthChf: chf(1000),
    peakAdjustedNetWorthChf: chf(1000),
    netExternalFlowsTodayChf: chf(0),
    realizedTradingPnlTodayChf: chf(0),
    sourceLedgerHeadHash: HASH_A,
    sourceFingerprint: HASH_B,
    ...overrides,
  };
}

function policy(overrides: Partial<PortfolioSafetyPolicy> = {}): PortfolioSafetyPolicy {
  return {
    version: PORTFOLIO_SAFETY_POLICY_VERSION,
    maxAdjustedDailyLossChf: chf(100),
    maxAdjustedDailyLossBp: 1000,
    maxRealizedTradingLossChf: chf(100),
    maxIntradayDrawdownChf: chf(150),
    maxIntradayDrawdownBp: 1500,
    maxGrossExposureBp: 8000,
    maxSinglePositionExposureBp: 5000,
    maxOpenPositions: 5,
    requireCompleteFinancialPricing: true,
    ...overrides,
  };
}

function armed(): KillSwitchState {
  return {
    version: PORTFOLIO_KILL_SWITCH_VERSION,
    status: 'ARMED',
    tripId: null,
    trippedAt: null,
    reasons: [],
    triggeringDecisionFingerprint: null,
  };
}

function tripped(): KillSwitchState {
  return {
    version: PORTFOLIO_KILL_SWITCH_VERSION,
    status: 'TRIPPED',
    tripId: 'trip_' + 'c'.repeat(40),
    trippedAt: '2026-10-14T10:00:00.000Z',
    reasons: ['prior daily loss breach'],
    triggeringDecisionFingerprint: 'd'.repeat(64),
  };
}

function request(overrides: Partial<PortfolioSafetyRequest> = {}): PortfolioSafetyRequest {
  return {
    portfolio: portfolio(),
    day: day(),
    previousKillSwitch: armed(),
    policy: policy(),
    ...overrides,
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof PortfolioSafetyError ? error.code : 'UNCLASSIFIED:' + String(error);
  }
}

describe('O15 portfolio safety envelope — RED', () => {
  it('has explicit version identities and is deterministic', () => {
    expect(PORTFOLIO_SAFETY_ENVELOPE_VERSION).toBe('portfolio-safety-envelope:v1');
    const req = request();
    const a = evaluatePortfolioSafetyEnvelope(req);
    const b = evaluatePortfolioSafetyEnvelope(req);
    expect(b).toEqual(a);
    expect(a.decisionId).toMatch(/^pse_[0-9a-f]{40}$/);
    expect(() => verifyPortfolioSafetyDecision(req, a)).not.toThrow();
  });

  it('a healthy zero-loss portfolio is NORMAL and cannot unlock live execution', () => {
    const result = evaluatePortfolioSafetyEnvelope(request());
    expect(result.state).toBe('NORMAL');
    expect(result.canIncreaseRisk).toBe(true);
    expect(result.canReduceRisk).toBe(true);
    expect(result.liveOrderAllowed).toBe(false);
    expect(result.physicalPurchaseAllowed).toBe(false);
  });

  it('external deposits and withdrawals do not masquerade as trading P&L', () => {
    const deposit = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1100)) }),
      day: day({ netExternalFlowsTodayChf: chf(100), peakAdjustedNetWorthChf: chf(1000) }),
    }));
    expect(deposit.metrics.adjustedCurrentNetWorthChf).toBe(chf(1000));
    expect(deposit.metrics.adjustedDailyPnlChf).toBe(chf(0));
    expect(deposit.metrics.adjustedDailyLossChf).toBe(chf(0));

    const withdrawal = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(900)) }),
      day: day({ netExternalFlowsTodayChf: chf(-100), peakAdjustedNetWorthChf: chf(1000) }),
    }));
    expect(withdrawal.metrics.adjustedCurrentNetWorthChf).toBe(chf(1000));
    expect(withdrawal.metrics.adjustedDailyPnlChf).toBe(chf(0));
    expect(withdrawal.metrics.adjustedDailyLossChf).toBe(chf(0));
  });

  it('trips exactly at the adjusted daily CHF loss limit', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(900)) }),
      policy: policy({ maxAdjustedDailyLossChf: chf(100), maxAdjustedDailyLossBp: 9999 }),
    }));
    expect(result.metrics.adjustedDailyLossChf).toBe(chf(100));
    expect(result.state).toBe('TRIPPED');
    expect(result.hardBreachReasons).toContain('adjusted daily loss reached CHF limit');
  });

  it('one Rappen below the CHF loss limit does not trip that limit', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(rappen(chf(1000) - chf(100) + 1n)) }),
      policy: policy({ maxAdjustedDailyLossChf: chf(100), maxAdjustedDailyLossBp: 9999 }),
    }));
    expect(result.metrics.adjustedDailyLossChf).toBe(rappen(chf(100) - 1n));
    expect(result.hardBreachReasons).not.toContain('adjusted daily loss reached CHF limit');
  });

  it('trips exactly at the adjusted daily bp loss limit', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(950)) }),
      policy: policy({ maxAdjustedDailyLossChf: chf(999), maxAdjustedDailyLossBp: 500 }),
    }));
    expect(result.metrics.adjustedDailyLossBp).toBe(500);
    expect(result.state).toBe('TRIPPED');
  });

  it('trips exactly at the realized trading loss limit', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      day: day({ realizedTradingPnlTodayChf: chf(-100) }),
      policy: policy({ maxRealizedTradingLossChf: chf(100) }),
    }));
    expect(result.metrics.realizedTradingLossChf).toBe(chf(100));
    expect(result.state).toBe('TRIPPED');
    expect(result.hardBreachReasons).toContain('realized trading loss reached CHF limit');
  });

  it('trips exactly at CHF and bp intraday drawdown limits', () => {
    const byChf = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(900)) }),
      day: day({ peakAdjustedNetWorthChf: chf(1050) }),
      policy: policy({
        maxAdjustedDailyLossChf: chf(999),
        maxAdjustedDailyLossBp: 9999,
        maxIntradayDrawdownChf: chf(150),
        maxIntradayDrawdownBp: 9999,
      }),
    }));
    expect(byChf.metrics.intradayDrawdownChf).toBe(chf(150));
    expect(byChf.state).toBe('TRIPPED');

    const byBp = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(950)) }),
      day: day({ peakAdjustedNetWorthChf: chf(1000) }),
      policy: policy({
        maxAdjustedDailyLossChf: chf(999),
        maxAdjustedDailyLossBp: 9999,
        maxIntradayDrawdownChf: chf(999),
        maxIntradayDrawdownBp: 500,
      }),
    }));
    expect(byBp.metrics.intradayDrawdownBp).toBe(500);
    expect(byBp.state).toBe('TRIPPED');
  });

  it('gross exposure below, at and above the cap has exact semantics', () => {
    const below = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf(799))] }),
      policy: policy({ maxGrossExposureBp: 8000, maxSinglePositionExposureBp: 9999 }),
    }));
    expect(below.state).toBe('NORMAL');

    const exact = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf(800))] }),
      policy: policy({ maxGrossExposureBp: 8000, maxSinglePositionExposureBp: 9999 }),
    }));
    expect(exact.state).toBe('CAPACITY_BLOCK');
    expect(exact.capacityBlockReasons).toContain('gross exposure is at limit');

    const above = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf(801))] }),
      policy: policy({ maxGrossExposureBp: 8000, maxSinglePositionExposureBp: 9999 }),
    }));
    expect(above.state).toBe('TRIPPED');
    expect(above.hardBreachReasons).toContain('gross exposure exceeds limit');
  });

  it('single-position exposure below, at and above the cap has exact semantics', () => {
    const exact = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf(500))] }),
      policy: policy({ maxGrossExposureBp: 9999, maxSinglePositionExposureBp: 5000 }),
    }));
    expect(exact.state).toBe('CAPACITY_BLOCK');
    expect(exact.capacityBlockReasons).toContain('single position exposure is at limit');

    const above = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf(501))] }),
      policy: policy({ maxGrossExposureBp: 9999, maxSinglePositionExposureBp: 5000 }),
    }));
    expect(above.state).toBe('TRIPPED');
    expect(above.hardBreachReasons).toContain('single position exposure exceeds limit');
  });

  it('open-position count exactly at the cap blocks capacity and above it trips', () => {
    const two = [position('A'), position('B')];
    const exact = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: two }),
      policy: policy({ maxOpenPositions: 2, maxGrossExposureBp: 9999, maxSinglePositionExposureBp: 9999 }),
    }));
    expect(exact.state).toBe('CAPACITY_BLOCK');
    expect(exact.capacityBlockReasons).toContain('open position count is at limit');

    const three = [position('A'), position('B'), position('C')];
    const above = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: three }),
      policy: policy({ maxOpenPositions: 2, maxGrossExposureBp: 9999, maxSinglePositionExposureBp: 9999 }),
    }));
    expect(above.state).toBe('TRIPPED');
  });

  it('incomplete, stale and unpriced financial data create DATA_HOLD without newly tripping', () => {
    const stale = position('AAPL', chf(200), { priceStatus: 'stale', marketValueChf: null });
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({
        capital: capital(chf(1000), {
          dataStatus: {
            financialMarketData: 'partial',
            inventoryMarketData: 'not_required',
            unpricedPositions: [],
            stalePositions: ['paper:AAPL'],
          },
        }),
        positions: [stale],
      }),
    }));
    expect(result.state).toBe('DATA_HOLD');
    expect(result.killSwitch.status).toBe('ARMED');
    expect(result.metrics.grossExposureChf).toBeNull();
    expect(result.dataHoldReasons).toContain('financial pricing is incomplete');
  });

  it('capital shortfall and non-positive net worth hard-trip the envelope', () => {
    const shortfall = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1000), { capitalShortfallChf: chf(1) }) }),
    }));
    expect(shortfall.state).toBe('TRIPPED');
    expect(shortfall.hardBreachReasons).toContain('capital shortfall is positive');

    const zero = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(0)) }),
      day: day({ startNetWorthChf: chf(1000), peakAdjustedNetWorthChf: chf(1000) }),
      policy: policy({ maxAdjustedDailyLossChf: chf(9999), maxAdjustedDailyLossBp: 9999 }),
    }));
    expect(zero.state).toBe('TRIPPED');
    expect(zero.hardBreachReasons).toContain('total net worth is non-positive');
  });

  it('a previously tripped kill switch remains latched after metrics recover', () => {
    const previous = tripped();
    const result = evaluatePortfolioSafetyEnvelope(request({ previousKillSwitch: previous }));
    expect(result.state).toBe('TRIPPED');
    expect(result.killSwitch).toEqual(previous);
    expect(result.canIncreaseRisk).toBe(false);
    expect(result.canReduceRisk).toBe(true);
    expect(result.alerts.map((a) => a.code)).toContain('KILL_SWITCH_LATCHED');
  });

  it('DATA_HOLD can recover to NORMAL when data recovers and the switch was not tripped', () => {
    const held = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({
        capital: capital(chf(1000), {
          dataStatus: {
            financialMarketData: 'partial',
            inventoryMarketData: 'not_required',
            unpricedPositions: ['paper:AAPL'],
            stalePositions: [],
          },
        }),
        positions: [position('AAPL', chf(200), { marketValueChf: null, priceStatus: 'not_connected' })],
      }),
    }));
    expect(held.state).toBe('DATA_HOLD');

    const recovered = evaluatePortfolioSafetyEnvelope(request());
    expect(recovered.state).toBe('NORMAL');
    expect(recovered.killSwitch.status).toBe('ARMED');
  });

  it('refuses inconsistent peak/timestamp/hash inputs', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      day: day({ peakAdjustedNetWorthChf: chf(900) }),
    })))).toBe('INVALID_DAY');

    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      day: day({ asOf: '2026-10-14T12:00:00Z' }),
    })))).toBe('INVALID_DAY');

    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      day: day({ sourceLedgerHeadHash: 'short' }),
    })))).toBe('INVALID_DAY');

    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1000), { timestamp: '2026-10-14T11:59:59.999Z' }) }),
    })))).toBe('INVALID_PORTFOLIO');
  });

  it('refuses duplicate open-position identity and invalid runtime money', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL'), position('AAPL')] }),
    })))).toBe('INVALID_PORTFOLIO');

    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      day: day({ startNetWorthChf: 1000 as never }),
    })))).toBe('INVALID_DAY');
  });

  it('refuses invalid basis-point and position-count policy', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      policy: policy({ maxAdjustedDailyLossBp: Number.NaN }),
    })))).toBe('INVALID_POLICY');

    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      policy: policy({ maxOpenPositions: 0 }),
    })))).toBe('INVALID_POLICY');
  });

  it('canonicalizes position and set-like data-status order for identity', () => {
    const p1 = position('A');
    const p2 = position('B');
    const c1 = capital(chf(1000), {
      dataStatus: {
        financialMarketData: 'complete',
        inventoryMarketData: 'not_required',
        unpricedPositions: [],
        stalePositions: [],
      },
    });
    const a = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: c1, positions: [p1, p2] }),
      policy: policy({ maxGrossExposureBp: 9999, maxSinglePositionExposureBp: 9999 }),
    }));
    const b = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: {
        ...c1,
        dataStatus: {
          ...c1.dataStatus,
          unpricedPositions: [...c1.dataStatus.unpricedPositions].reverse(),
          stalePositions: [...c1.dataStatus.stalePositions].reverse(),
        },
      }, positions: [p2, p1] }),
      policy: policy({ maxGrossExposureBp: 9999, maxSinglePositionExposureBp: 9999 }),
    }));
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.decisionId).toBe(a.decisionId);
  });

  it('verifier detects tampered metrics, state and trip identity', () => {
    const req = request({
      portfolio: portfolio({ capital: capital(chf(900)) }),
      policy: policy({ maxAdjustedDailyLossChf: chf(100), maxAdjustedDailyLossBp: 9999 }),
    });
    const result = evaluatePortfolioSafetyEnvelope(req);

    const metrics = structuredClone(result);
    metrics.metrics.adjustedDailyLossChf = chf(99);
    expect(codeOf(() => verifyPortfolioSafetyDecision(req, metrics))).toBe('INVALID_DECISION');

    const state = structuredClone(result);
    state.state = 'NORMAL';
    expect(codeOf(() => verifyPortfolioSafetyDecision(req, state))).toBe('INVALID_DECISION');

    const trip = structuredClone(result);
    trip.killSwitch.tripId = 'trip_' + 'f'.repeat(40);
    expect(codeOf(() => verifyPortfolioSafetyDecision(req, trip))).toBe('INVALID_DECISION');
  });
});
