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
    // The trip id is derived from the triggering fingerprint ('d' repeated), as O15 derives it when it trips.
    tripId: 'trip_' + 'd'.repeat(40),
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

// ---------------------------------------------------------------------------
// Independent review probes (RED). Each probe names one attack from the O15 review. A probe that fails today expects a refusal
// or a state the current code does not produce; the pins below already hold and keep their guarantee from regressing.
// ---------------------------------------------------------------------------

describe('O15 review — RED probes', () => {
  it('A1 a deposit with a trading loss still shows the loss and trips exactly at the CHF limit', () => {
    // start 1000, deposit 500, current 1400 => adjusted 900 => loss 100 => exactly the 100 CHF limit
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1400)) }),
      day: day({ netExternalFlowsTodayChf: chf(500), peakAdjustedNetWorthChf: chf(1000) }),
      policy: policy({ maxAdjustedDailyLossChf: chf(100), maxAdjustedDailyLossBp: 9999 }),
    }));
    expect(result.metrics.adjustedDailyLossChf).toBe(chf(100));
    expect(result.state).toBe('TRIPPED');
  });

  it('A2 a withdrawal with a trading gain shows the gain, not a loss', () => {
    // start 1000, withdrawal 300 (flow -300), current 900 => adjusted 1200 => gain 200
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(900)) }),
      day: day({ netExternalFlowsTodayChf: chf(-300), peakAdjustedNetWorthChf: chf(1200) }),
    }));
    expect(result.metrics.adjustedDailyPnlChf).toBe(chf(200));
    expect(result.metrics.adjustedDailyLossChf).toBe(chf(0));
    expect(result.state).toBe('NORMAL');
  });

  it('A3 flows larger than the current net worth produce a large adjusted loss that trips', () => {
    // start 1000, deposit 500, current 300 => adjusted -200 => loss 1200
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(300)) }),
      day: day({ netExternalFlowsTodayChf: chf(500), peakAdjustedNetWorthChf: chf(1000) }),
    }));
    expect(result.metrics.adjustedCurrentNetWorthChf).toBe(chf(-200));
    expect(result.state).toBe('TRIPPED');
    expect(result.hardBreachReasons).toContain('adjusted daily loss reached CHF limit');
  });

  it('A4 a zero CHF loss, realized-loss or drawdown limit is refused at policy time, not latched on a flat day', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ policy: policy({ maxAdjustedDailyLossChf: chf(0) }) })))).toBe('INVALID_POLICY');
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ policy: policy({ maxRealizedTradingLossChf: chf(0) }) })))).toBe('INVALID_POLICY');
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ policy: policy({ maxIntradayDrawdownChf: chf(0) }) })))).toBe('INVALID_POLICY');
  });

  it('D1 an open position with a market value but no quote is a data hold, not a healthy position', () => {
    const noQuote = position('AAPL', chf(200), { lastQuote: null });
    const result = evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [noQuote] }) }));
    expect(result.state).toBe('DATA_HOLD');
    expect(result.metrics.grossExposureChf).toBeNull();
  });

  it('D2 a quote timestamped after the portfolio asOf, or not in canonical UTC, is refused', () => {
    const future = position('AAPL', chf(200), {
      lastQuote: { instrumentId: 'AAPL', price: Decimal.from('200'), currency: 'CHF', asOf: '2026-10-14T12:00:01.000Z', source: 'fixture' },
    });
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [future] }) })))).toBe('INVALID_PORTFOLIO');

    const nonCanonical = position('AAPL', chf(200), {
      lastQuote: { instrumentId: 'AAPL', price: Decimal.from('200'), currency: 'CHF', asOf: '2026-10-14T12:00:00Z', source: 'fixture' },
    });
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [nonCanonical] }) })))).toBe('INVALID_PORTFOLIO');
  });

  it('D3 isOpen must agree with the quantity: a closed flag on a held position, or a zero quantity on an open one, is refused', () => {
    const hiddenHolding = position('AAPL', chf(200), { isOpen: false });
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [hiddenHolding] }) })))).toBe('INVALID_PORTFOLIO');

    const zeroQuantityOpen = position('AAPL', chf(200), { quantity: Decimal.from('0') });
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [zeroQuantityOpen] }) })))).toBe('INVALID_PORTFOLIO');

    const shortPosition = position('AAPL', chf(200), { quantity: Decimal.from('-1') });
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [shortPosition] }) })))).toBe('INVALID_PORTFOLIO');
  });

  it('D4 a previously tripped kill switch must carry a trip id derived from its triggering fingerprint', () => {
    const inconsistent = tripped();
    inconsistent.tripId = 'trip_' + 'c'.repeat(40);
    inconsistent.triggeringDecisionFingerprint = 'd'.repeat(64);
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ previousKillSwitch: inconsistent })))).toBe('INVALID_KILL_SWITCH');
  });

  it('H1 a portfolio without an inventory array is refused with a classified error', () => {
    const malformed = { ...portfolio(), inventory: undefined as never };
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ portfolio: malformed })))).toBe('INVALID_PORTFOLIO');
  });

  it('K1 a risk day that started on the prior UTC day cannot carry the current dayId', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      day: day({ dayStartedAt: '2026-10-13T23:00:00.000Z' }),
    })))).toBe('INVALID_DAY');
  });

  it('K2 a risk day whose asOf falls on the next UTC day cannot carry the current dayId', () => {
    const nextDay = '2026-10-15T00:30:00.000Z';
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1000), { timestamp: nextDay }) }),
      day: day({ asOf: nextDay }),
    })))).toBe('INVALID_DAY');
  });
});

describe('O15 review — input integrity, day identity and state matrix pins', () => {
  it('a negative market value, an invalid price status or a duplicated stale id is refused', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf(200), { marketValueChf: -1n as never })] }),
    })))).toBe('INVALID_PORTFOLIO');
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf(200), { priceStatus: 'banana' as never })] }),
    })))).toBe('INVALID_PORTFOLIO');
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1000), { dataStatus: { financialMarketData: 'complete', inventoryMarketData: 'not_required', unpricedPositions: [], stalePositions: ['paper:AAPL', 'paper:AAPL'] } }) }),
    })))).toBe('INVALID_PORTFOLIO');
  });

  it('a non-bigint capital number is refused, and a malformed financial coverage status holds open positions', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ capital: capital(1000 as never) }) })))).toBe('INVALID_PORTFOLIO');
    const malformed = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1000), { dataStatus: { financialMarketData: 'banana' as never, inventoryMarketData: 'not_required', unpricedPositions: [], stalePositions: [] } }) }),
    }));
    expect(malformed.state).toBe('DATA_HOLD');
  });

  it('a malformed broker id is refused', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf(200), { brokerId: '  ' })] }),
    })))).toBe('INVALID_PORTFOLIO');
  });

  it('a risk day that starts exactly at asOf on the same UTC day is accepted; one that starts after asOf is refused', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ day: day({ dayStartedAt: AS_OF }) })))).toBe('NO_ERROR');
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({ day: day({ dayStartedAt: '2026-10-14T13:00:00.000Z' }) })))).toBe('INVALID_DAY');
  });

  it('the same economics with a different source fingerprint yields a different decision identity', () => {
    const base = evaluatePortfolioSafetyEnvelope(request());
    expect(evaluatePortfolioSafetyEnvelope(request({ day: day({ sourceFingerprint: 'e'.repeat(64) }) })).decisionId).not.toBe(base.decisionId);
  });

  it('risk increase is allowed only in NORMAL, risk reduction is allowed in every state, and live and physical execution stay false', () => {
    const cases: Array<[string, PortfolioSafetyRequest, string]> = [
      ['NORMAL', request(), 'NORMAL'],
      ['CAPACITY_BLOCK', request({ policy: policy({ maxOpenPositions: 1 }) }), 'CAPACITY_BLOCK'],
      ['DATA_HOLD', request({ portfolio: portfolio({ positions: [position('AAPL', chf(200), { marketValueChf: null, priceStatus: 'stale' })] }) }), 'DATA_HOLD'],
      ['TRIPPED', request({ previousKillSwitch: tripped() }), 'TRIPPED'],
    ];
    for (const [label, req, expected] of cases) {
      const result = evaluatePortfolioSafetyEnvelope(req);
      expect(result.state, label).toBe(expected);
      expect(result.canIncreaseRisk, label).toBe(result.state === 'NORMAL');
      expect(result.canReduceRisk, label).toBe(true);
      expect(result.liveOrderAllowed, label).toBe(false);
      expect(result.physicalPurchaseAllowed, label).toBe(false);
    }
  });

  it('a breach and a data hold together are TRIPPED, and the data-hold reason is still reported', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(850)), positions: [position('AAPL', chf(200), { marketValueChf: null, priceStatus: 'stale' })] }),
    }));
    expect(result.state).toBe('TRIPPED');
    expect(result.dataHoldReasons).toContain('financial pricing is incomplete');
    expect(result.hardBreachReasons).toContain('adjusted daily loss reached CHF limit');
  });
});

describe('O15 review — pins that already hold', () => {
  it('a loss one basis point below the bp limit does not trip; exactly at it does; a fraction above it trips conservatively', () => {
    const at = (total: string) => evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(total)) }),
      policy: policy({ maxAdjustedDailyLossChf: chf(100), maxAdjustedDailyLossBp: 100 }),
    }));
    expect(at('990.10').metrics.adjustedDailyLossBp).toBe(99);
    expect(at('990.10').hardBreachReasons).not.toContain('adjusted daily loss reached bp limit');
    expect(at('990.00').hardBreachReasons).toContain('adjusted daily loss reached bp limit');
    expect(at('990.01').metrics.adjustedDailyLossBp).toBe(100);
    expect(at('990.01').hardBreachReasons).toContain('adjusted daily loss reached bp limit');
  });

  it('a drawdown half a basis point below the bp limit trips, because the drawdown basis point is rounded up', () => {
    // peak 1000, current 985.05 => drawdown 14.95 CHF = 149.5 bp; the CHF limit is far away, so only the bp limit can trip
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf('985.05')) }),
      policy: policy({ maxIntradayDrawdownChf: chf(1000), maxIntradayDrawdownBp: 150 }),
    }));
    expect(result.metrics.intradayDrawdownBp).toBe(150);
    expect(result.state).toBe('TRIPPED');
    expect(result.hardBreachReasons).toContain('intraday drawdown reached bp limit');
  });

  it('peak equal to start and to current means zero drawdown', () => {
    const result = evaluatePortfolioSafetyEnvelope(request());
    expect(result.metrics.intradayDrawdownChf).toBe(chf(0));
    expect(result.metrics.intradayDrawdownBp).toBe(0);
  });

  it('a peak below the current adjusted net worth is refused', () => {
    expect(codeOf(() => evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1200)) }),
      day: day({ peakAdjustedNetWorthChf: chf(1000) }),
    })))).toBe('INVALID_DAY');
  });

  it('a negative adjusted current net worth yields a finite drawdown basis point', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(100)) }),
      day: day({ netExternalFlowsTodayChf: chf(500), peakAdjustedNetWorthChf: chf(1000) }),
    }));
    expect(Number.isFinite(result.metrics.intradayDrawdownBp)).toBe(true);
    // peak 1000 minus adjusted current -400 (100 - 500) => drawdown 1400
    expect(result.metrics.intradayDrawdownChf).toBe(chf(1400));
  });

  it('complete coverage with a null market value or a non-live open position is a data hold', () => {
    expect(evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [position('AAPL', chf(200), { marketValueChf: null })] }) })).state).toBe('DATA_HOLD');
    expect(evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [position('AAPL', chf(200), { priceStatus: 'stale' })] }) })).state).toBe('DATA_HOLD');
  });

  it('an unpriced id that matches no position still holds, and a closed stale position holds', () => {
    const ghost = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1000), { dataStatus: { financialMarketData: 'complete', inventoryMarketData: 'not_required', unpricedPositions: ['paper:GHOST'], stalePositions: [] } }) }),
    }));
    expect(ghost.state).toBe('DATA_HOLD');

    const closedStale = position('OLD', chf(0), { isOpen: false, quantity: Decimal.from('0'), priceStatus: 'stale', marketValueChf: null, lastQuote: null, averageCostChf: null });
    const held = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({
        capital: capital(chf(1000), { dataStatus: { financialMarketData: 'complete', inventoryMarketData: 'not_required', unpricedPositions: [], stalePositions: ['paper:OLD'] } }),
        positions: [closedStale],
      }),
    }));
    expect(held.state).toBe('DATA_HOLD');
  });

  it('partial coverage with no open position is not a data hold', () => {
    const closed = position('OLD', chf(0), { isOpen: false, quantity: Decimal.from('0'), priceStatus: 'not_connected', marketValueChf: null, lastQuote: null, averageCostChf: null });
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(1000), { dataStatus: { financialMarketData: 'partial', inventoryMarketData: 'not_required', unpricedPositions: [], stalePositions: [] } }), positions: [closed] }),
    }));
    expect(result.state).toBe('NORMAL');
  });

  it('zero net worth trips and leaves the exposure ratios null', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ capital: capital(chf(0)) }),
      day: day({ startNetWorthChf: chf(1000), peakAdjustedNetWorthChf: chf(1000) }),
      policy: policy({ maxAdjustedDailyLossChf: chf(9999), maxAdjustedDailyLossBp: 9999 }),
    }));
    expect(result.state).toBe('TRIPPED');
    expect(result.metrics.grossExposureBp).toBeNull();
    expect(result.metrics.maximumPositionExposureBp).toBeNull();
  });

  it('the same instrument at two brokers counts as two open positions, and closed positions do not count', () => {
    const second = position('AAPL', chf(200), { brokerId: 'other' });
    const closed = position('OLD', chf(0), { isOpen: false, quantity: Decimal.from('0'), priceStatus: 'not_connected', marketValueChf: null, lastQuote: null, averageCostChf: null });
    const result = evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [position('AAPL'), second, closed] }) }));
    expect(result.metrics.openPositionCount).toBe(2);
  });

  it('gross exposure exactly one basis point over the cap is conservative: the ceiling trips it', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf('800.03'))] }),
      policy: policy({ maxGrossExposureBp: 8000, maxSinglePositionExposureBp: 9999 }),
    }));
    expect(result.metrics.grossExposureBp).toBe(8001);
    expect(result.hardBreachReasons).toContain('gross exposure exceeds limit');
  });

  it('gross exposure at the cap while a single position is over its cap keeps the capacity reason and trips', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      policy: policy({ maxGrossExposureBp: 2000, maxSinglePositionExposureBp: 1000 }),
    }));
    expect(result.state).toBe('TRIPPED');
    expect(result.capacityBlockReasons).toContain('gross exposure is at limit');
    expect(result.hardBreachReasons).toContain('single position exposure exceeds limit');
  });

  it('under a data hold the open-position capacity reason is still reported and risk increase stays blocked', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      portfolio: portfolio({ positions: [position('AAPL', chf(200), { marketValueChf: null, priceStatus: 'not_connected' })] }),
      policy: policy({ maxOpenPositions: 1 }),
    }));
    expect(result.state).toBe('DATA_HOLD');
    expect(result.capacityBlockReasons).toContain('open position count is at limit');
    expect(result.canIncreaseRisk).toBe(false);
  });

  it('a previously tripped switch keeps its original trip id and reasons when a later breach differs', () => {
    const previous = tripped();
    previous.tripId = 'trip_' + 'd'.repeat(40);
    const result = evaluatePortfolioSafetyEnvelope(request({
      previousKillSwitch: previous,
      portfolio: portfolio({ capital: capital(chf(100)) }),
    }));
    expect(result.killSwitch).toEqual(previous);
    expect(result.state).toBe('TRIPPED');
  });

  it('a tripped switch stays tripped under a data hold', () => {
    const result = evaluatePortfolioSafetyEnvelope(request({
      previousKillSwitch: tripped(),
      portfolio: portfolio({ positions: [position('AAPL', chf(200), { marketValueChf: null, priceStatus: 'stale' })] }),
    }));
    expect(result.state).toBe('TRIPPED');
    expect(result.dataHoldReasons.length).toBeGreaterThan(0);
  });

  it('the same breach produces the same trip id; reordered previous reasons do not change the decision identity', async () => {
    const breach = request({ portfolio: portfolio({ capital: capital(chf(850)) }) });
    expect(evaluatePortfolioSafetyEnvelope(breach).killSwitch.tripId).toBe(evaluatePortfolioSafetyEnvelope(breach).killSwitch.tripId);

    const a = { ...tripped(), reasons: ['alpha breach', 'beta breach'] };
    const b = { ...tripped(), reasons: ['beta breach', 'alpha breach'] };
    expect(evaluatePortfolioSafetyEnvelope(request({ previousKillSwitch: b })).decisionId).toBe(evaluatePortfolioSafetyEnvelope(request({ previousKillSwitch: a })).decisionId);
  });

  it('the module exposes no reset, clear, arm or unlatch function', async () => {
    const mod = await import('../../src/safety/portfolio-safety-envelope.js');
    expect(Object.keys(mod).filter((name) => /reset|clear|arm|unlatch|untrip|enable/i.test(name))).toEqual([]);
  });

  it('a semantic change to policy, source hashes, data hold or a hard breach changes the decision identity', () => {
    const base = evaluatePortfolioSafetyEnvelope(request());
    expect(evaluatePortfolioSafetyEnvelope(request({ policy: policy({ maxOpenPositions: 4 }) })).decisionId).not.toBe(base.decisionId);
    expect(evaluatePortfolioSafetyEnvelope(request({ day: day({ sourceLedgerHeadHash: 'e'.repeat(64) }) })).decisionId).not.toBe(base.decisionId);
    expect(evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ positions: [position('AAPL', chf(200), { marketValueChf: null, priceStatus: 'stale' })] }) })).decisionId).not.toBe(base.decisionId);
    expect(evaluatePortfolioSafetyEnvelope(request({ portfolio: portfolio({ capital: capital(chf(850)) }) })).decisionId).not.toBe(base.decisionId);
  });

  it('the verifier rejects a reissued decision with tampered flags, alerts, source fingerprints or identity', () => {
    const req = request({ portfolio: portfolio({ capital: capital(chf(850)) }) });
    const result = evaluatePortfolioSafetyEnvelope(req);
    const flag = structuredClone(result) as { canIncreaseRisk: boolean };
    flag.canIncreaseRisk = true;
    expect(codeOf(() => verifyPortfolioSafetyDecision(req, flag as never))).toBe('INVALID_DECISION');

    const live = structuredClone(result) as { liveOrderAllowed: boolean };
    live.liveOrderAllowed = true;
    expect(codeOf(() => verifyPortfolioSafetyDecision(req, live as never))).toBe('INVALID_DECISION');

    const alerts = structuredClone(result);
    alerts.alerts = [];
    expect(codeOf(() => verifyPortfolioSafetyDecision(req, alerts))).toBe('INVALID_DECISION');

    const fingerprint = structuredClone(result);
    fingerprint.sourceFingerprints.portfolio = 'f'.repeat(64);
    expect(codeOf(() => verifyPortfolioSafetyDecision(req, fingerprint))).toBe('INVALID_DECISION');

    const identity = structuredClone(result);
    identity.decisionId = 'pse_' + 'e'.repeat(40);
    expect(codeOf(() => verifyPortfolioSafetyDecision(req, identity))).toBe('INVALID_DECISION');
  });

  it('the review module imports no broker, ledger, registry, champion, capital, audit or network module at runtime', async () => {
    const { readFileSync } = await import('node:fs');
    const forbidden = /broker|ledger|registry|champion|capital|audit|network|http|provider|adapter/i;
    const source = readFileSync(new URL('../../src/safety/portfolio-safety-envelope.ts', import.meta.url), 'utf8');
    const runtimeImports = [...source.matchAll(/^import (?!type )[^;]*from '([^']+)';/gm)].map((match) => match[1]!);
    expect(runtimeImports.filter((spec) => forbidden.test(spec))).toEqual([]);
  });
});
