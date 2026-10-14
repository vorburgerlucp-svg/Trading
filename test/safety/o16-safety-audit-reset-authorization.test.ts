import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import type { CapitalState, PortfolioSnapshot, PositionView } from '../../src/capital/capital-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { chf } from '../../src/money/money.js';
import {
  PORTFOLIO_KILL_SWITCH_VERSION,
  PORTFOLIO_SAFETY_POLICY_VERSION,
  RISK_DAY_SUMMARY_VERSION,
  evaluatePortfolioSafetyEnvelope,
  type KillSwitchState,
  type PortfolioSafetyPolicy,
  type PortfolioSafetyRequest,
  type RiskDaySummary,
} from '../../src/safety/portfolio-safety-envelope.js';
import {
  SAFETY_ALERT_POLICY_VERSION,
  SafetyAlertError,
  buildSafetyAlertBatch,
  verifySafetyAlertBatch,
  type SafetyAlertPolicy,
} from '../../src/safety/safety-alerting.js';
import {
  KILL_SWITCH_RESET_POLICY_VERSION,
  KillSwitchResetError,
  assessKillSwitchRecovery,
  authorizeKillSwitchReset,
  buildKillSwitchResetApproval,
  buildKillSwitchResetRequest,
  verifyKillSwitchResetAuthorization,
  type KillSwitchResetPolicy,
} from '../../src/safety/kill-switch-reset-authorization.js';
import {
  SafetyGovernanceStore,
  SafetyGovernanceStoreError,
} from '../../src/safety/safety-governance-store.js';
import { SafetyAuditService } from '../../src/safety/safety-audit.js';

const DAY_START = '2026-10-14T00:00:00.000Z';
const TRIP_AT = '2026-10-14T10:00:00.000Z';
const REQUEST_AT = '2026-10-14T10:30:00.000Z';
const APPROVE_AT = '2026-10-14T11:00:00.000Z';
const AS_OF = '2026-10-14T11:00:00.000Z';

function position(overrides: Partial<PositionView> = {}): PositionView {
  return {
    brokerId: 'paper',
    instrumentId: 'AAPL',
    symbol: 'AAPL',
    assetClass: 'stock',
    isOpen: true,
    quantity: Decimal.from('1'),
    costBasisChf: chf(200),
    averageCostChf: Decimal.from('200'),
    priceStatus: 'live',
    lastQuote: {
      instrumentId: 'AAPL',
      price: Decimal.from('200'),
      currency: 'CHF',
      asOf: AS_OF,
      source: 'fixture',
    },
    marketValueChf: chf(200),
    unrealizedPnlChf: chf(0),
    realizedPnlChf: chf(0),
    feesChf: chf(0),
    carryingValueChf: chf(200),
    settlementDays: 2,
    ...overrides,
  };
}

function capital(
  asOf = AS_OF,
  total = chf(1000),
  overrides: Partial<CapitalState> = {},
): CapitalState {
  return {
    timestamp: asOf,
    baseCurrency: 'CHF',
    totalNetWorthChf: total,
    cash: {
      bankChf: total,
      brokerCashChf: chf(0),
      cryptoCashChf: chf(0),
      physicalCashChf: chf(0),
      totalChf: total,
      unreservedChf: total,
    },
    reservedCapitalChf: chf(0),
    committedCapitalChf: chf(0),
    safetyReserveChf: chf(0),
    availableCapitalChf: total,
    capitalShortfallChf: chf(0),
    financialAssetsChf: chf(0),
    financialAssetsCostChf: chf(0),
    physicalInventoryCostChf: chf(0),
    physicalInventoryMarketValueChf: null,
    receivablesChf: chf(0),
    liabilitiesChf: chf(0),
    investedCapitalChf: chf(0),
    boundCapitalChf: chf(0),
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

function portfolio(
  asOf = AS_OF,
  total = chf(1000),
  overrides: { capital?: CapitalState; positions?: PositionView[] } = {},
): PortfolioSnapshot {
  return {
    capital: overrides.capital ?? capital(asOf, total),
    positions: overrides.positions ?? [],
    inventory: [],
  };
}

function day(
  asOf = AS_OF,
  overrides: Partial<RiskDaySummary> = {},
): RiskDaySummary {
  return {
    version: RISK_DAY_SUMMARY_VERSION,
    dayId: '2026-10-14',
    dayStartedAt: DAY_START,
    asOf,
    startNetWorthChf: chf(1000),
    peakAdjustedNetWorthChf: chf(1000),
    netExternalFlowsTodayChf: chf(0),
    realizedTradingPnlTodayChf: chf(0),
    sourceLedgerHeadHash: 'a'.repeat(64),
    sourceFingerprint: 'b'.repeat(64),
    ...overrides,
  };
}

function safetyPolicy(overrides: Partial<PortfolioSafetyPolicy> = {}): PortfolioSafetyPolicy {
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
    maxFinancialQuoteAgeMs: 15 * 60_000,
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

function safetyRequest(
  asOf = AS_OF,
  overrides: Partial<PortfolioSafetyRequest> = {},
): PortfolioSafetyRequest {
  return {
    portfolio: portfolio(asOf),
    day: day(asOf),
    previousKillSwitch: armed(),
    policy: safetyPolicy(),
    ...overrides,
  };
}

function healthyTrippedSource(): PortfolioSafetyRequest {
  const breachRequest = safetyRequest(TRIP_AT, {
    portfolio: portfolio(TRIP_AT, chf(900)),
    day: day(TRIP_AT),
    policy: safetyPolicy({
      maxAdjustedDailyLossChf: chf(100),
      maxAdjustedDailyLossBp: 9999,
      maxRealizedTradingLossChf: chf(999),
      maxIntradayDrawdownChf: chf(999),
      maxIntradayDrawdownBp: 9999,
    }),
  });
  const trip = evaluatePortfolioSafetyEnvelope(breachRequest).killSwitch;
  expect(trip.status).toBe('TRIPPED');

  return safetyRequest(AS_OF, {
    portfolio: portfolio(AS_OF, chf(1000)),
    day: day(AS_OF),
    previousKillSwitch: trip,
    policy: breachRequest.policy,
  });
}

const alertPolicy: SafetyAlertPolicy = {
  version: SAFETY_ALERT_POLICY_VERSION,
  emitNormalState: false,
  emitCapacityBlock: true,
  emitDataHold: true,
  emitTrip: true,
  includeAllReasons: true,
};

const resetPolicy: KillSwitchResetPolicy = {
  version: KILL_SWITCH_RESET_POLICY_VERSION,
  minimumCooldownMs: 30 * 60_000,
  authorizationTtlMs: 15 * 60_000,
  requireDistinctApprover: true,
  requireRecoveryState: 'NORMAL',
  minimumRationaleLength: 12,
};

function errorCode(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    if (error instanceof SafetyAlertError || error instanceof KillSwitchResetError || error instanceof SafetyGovernanceStoreError) {
      return error.code;
    }
    return 'UNCLASSIFIED:' + String(error);
  }
}

describe('O16 safety alerting — RED', () => {
  it('NORMAL produces an empty deterministic batch', () => {
    const decision = evaluatePortfolioSafetyEnvelope(safetyRequest());
    const a = buildSafetyAlertBatch(decision, alertPolicy);
    const b = buildSafetyAlertBatch(decision, alertPolicy);
    expect(a).toEqual(b);
    expect(a.alerts).toEqual([]);
    expect(a.alertBatchId).toMatch(/^sab_[0-9a-f]{40}$/);
    expect(() => verifySafetyAlertBatch(decision, a)).not.toThrow();
  });

  it('CAPACITY_BLOCK produces warning alerts', () => {
    const p = position({ lastQuote: { ...position().lastQuote!, asOf: AS_OF } });
    const decision = evaluatePortfolioSafetyEnvelope(safetyRequest(AS_OF, {
      portfolio: portfolio(AS_OF, chf(1000), { positions: [p] }),
      policy: safetyPolicy({ maxOpenPositions: 1, maxGrossExposureBp: 9999, maxSinglePositionExposureBp: 9999 }),
    }));
    expect(decision.state).toBe('CAPACITY_BLOCK');
    const batch = buildSafetyAlertBatch(decision, alertPolicy);
    expect(batch.alerts.length).toBeGreaterThan(0);
    expect(batch.alerts.every((a) => a.severity === 'warning')).toBe(true);
  });

  it('DATA_HOLD produces warning alerts', () => {
    const p = position({ lastQuote: null, marketValueChf: null, priceStatus: 'not_connected' });
    const c = capital(AS_OF, chf(1000), {
      dataStatus: {
        financialMarketData: 'partial',
        inventoryMarketData: 'not_required',
        unpricedPositions: ['paper:AAPL'],
        stalePositions: [],
      },
    });
    const decision = evaluatePortfolioSafetyEnvelope(safetyRequest(AS_OF, {
      portfolio: portfolio(AS_OF, chf(1000), { capital: c, positions: [p] }),
    }));
    expect(decision.state).toBe('DATA_HOLD');
    const batch = buildSafetyAlertBatch(decision, alertPolicy);
    expect(batch.alerts.some((a) => a.severity === 'warning')).toBe(true);
  });

  it('TRIPPED produces critical alert and never downgrades an O15 trip descriptor', () => {
    const decision = evaluatePortfolioSafetyEnvelope(safetyRequest(TRIP_AT, {
      portfolio: portfolio(TRIP_AT, chf(900)),
      day: day(TRIP_AT),
      policy: safetyPolicy({ maxAdjustedDailyLossBp: 9999 }),
    }));
    expect(decision.state).toBe('TRIPPED');
    const batch = buildSafetyAlertBatch(decision, alertPolicy);
    expect(batch.alerts.length).toBeGreaterThan(0);
    expect(batch.alerts.some((a) => a.severity === 'critical')).toBe(true);
    for (const descriptor of decision.alerts.filter((a) => a.severity === 'trip')) {
      expect(batch.alerts.find((a) => a.code === descriptor.code && a.reason === descriptor.reason)?.severity).toBe('critical');
    }
  });

  it('tampered alert batch is refused', () => {
    const decision = evaluatePortfolioSafetyEnvelope(safetyRequest());
    const batch = buildSafetyAlertBatch(decision, alertPolicy);
    const tampered = structuredClone(batch);
    tampered.safetyDecisionFingerprint = 'f'.repeat(64);
    expect(errorCode(() => verifySafetyAlertBatch(decision, tampered))).toBe('INVALID_BATCH');
  });
});

describe('O16 recovery and reset authorization — RED', () => {
  it('assesses recovery hypothetically without mutating the persisted TRIPPED source state', () => {
    const source = healthyTrippedSource();
    const before = structuredClone(source.previousKillSwitch);
    const recovery = assessKillSwitchRecovery(source);
    expect(recovery.state).toBe('NORMAL');
    expect(recovery.canIncreaseRisk).toBe(true);
    expect(source.previousKillSwitch).toEqual(before);
    expect(source.previousKillSwitch.status).toBe('TRIPPED');
  });

  it('refuses reset request while current recovery is DATA_HOLD or CAPACITY_BLOCK', () => {
    const base = healthyTrippedSource();

    const heldPosition = position({ lastQuote: null, marketValueChf: null, priceStatus: 'not_connected' });
    const heldCapital = capital(AS_OF, chf(1000), {
      dataStatus: {
        financialMarketData: 'partial',
        inventoryMarketData: 'not_required',
        unpricedPositions: ['paper:AAPL'],
        stalePositions: [],
      },
    });
    const held = {
      ...base,
      portfolio: portfolio(AS_OF, chf(1000), { capital: heldCapital, positions: [heldPosition] }),
    };
    expect(errorCode(() => buildKillSwitchResetRequest(held, {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human', id: 'human-a' },
      rationale: 'Pricing must be restored first.',
      policy: resetPolicy,
    }))).toBe('RECOVERY_NOT_NORMAL');

    const capPosition = position({ lastQuote: { ...position().lastQuote!, asOf: AS_OF } });
    const capacity = {
      ...base,
      portfolio: portfolio(AS_OF, chf(1000), { positions: [capPosition] }),
      policy: safetyPolicy({
        ...base.policy,
        maxOpenPositions: 1,
        maxGrossExposureBp: 9999,
        maxSinglePositionExposureBp: 9999,
      }),
    };
    expect(errorCode(() => buildKillSwitchResetRequest(capacity, {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human', id: 'human-a' },
      rationale: 'Capacity should be reduced first.',
      policy: resetPolicy,
    }))).toBe('RECOVERY_NOT_NORMAL');
  });

  it('builds a deterministic reset request bound to trip, recovery and policy', () => {
    const source = healthyTrippedSource();
    const input = {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human' as const, id: 'human-a' },
      rationale: 'The breach has cleared and the portfolio is healthy.',
      policy: resetPolicy,
    };
    const a = buildKillSwitchResetRequest(source, input);
    const b = buildKillSwitchResetRequest(source, input);
    expect(b).toEqual(a);
    expect(a.requestId).toMatch(/^ksrr_[0-9a-f]{40}$/);
    expect(a.tripId).toBe(source.previousKillSwitch.tripId);
  });

  it('requires distinct human approval and rejects self approval', () => {
    const source = healthyTrippedSource();
    const request = buildKillSwitchResetRequest(source, {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human', id: 'human-a' },
      rationale: 'The breach has cleared and the portfolio is healthy.',
      policy: resetPolicy,
    });
    expect(errorCode(() => buildKillSwitchResetApproval(request, {
      approvedAt: APPROVE_AT,
      approver: { kind: 'human', id: 'human-a' },
      decision: 'APPROVE',
      rationale: 'I approve this reset request.',
      policy: resetPolicy,
    }))).toBe('SELF_APPROVAL');

    const approval = buildKillSwitchResetApproval(request, {
      approvedAt: APPROVE_AT,
      approver: { kind: 'human', id: 'human-b' },
      decision: 'APPROVE',
      rationale: 'Independent review confirms recovery.',
      policy: resetPolicy,
    });
    expect(approval.approvalId).toMatch(/^ksra_[0-9a-f]{40}$/);
  });

  it('refuses approval before request and malformed rationale', () => {
    const source = healthyTrippedSource();
    const request = buildKillSwitchResetRequest(source, {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human', id: 'human-a' },
      rationale: 'The breach has cleared and the portfolio is healthy.',
      policy: resetPolicy,
    });

    expect(errorCode(() => buildKillSwitchResetApproval(request, {
      approvedAt: '2026-10-14T10:29:59.999Z',
      approver: { kind: 'human', id: 'human-b' },
      decision: 'APPROVE',
      rationale: 'Independent review confirms recovery.',
      policy: resetPolicy,
    }))).toBe('INVALID_APPROVAL');

    expect(errorCode(() => buildKillSwitchResetApproval(request, {
      approvedAt: APPROVE_AT,
      approver: { kind: 'human', id: 'human-b' },
      decision: 'APPROVE',
      rationale: 'short',
      policy: resetPolicy,
    }))).toBe('INVALID_APPROVAL');
  });

  it('enforces cooldown exactly and REJECT never authorizes', () => {
    const source = healthyTrippedSource();
    const request = buildKillSwitchResetRequest(source, {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human', id: 'human-a' },
      rationale: 'The breach has cleared and the portfolio is healthy.',
      policy: resetPolicy,
    });
    const early = buildKillSwitchResetApproval(request, {
      approvedAt: '2026-10-14T10:29:59.999Z',
      approver: { kind: 'human', id: 'human-b' },
      decision: 'APPROVE',
      rationale: 'Independent review confirms recovery.',
      policy: resetPolicy,
    });
    expect(errorCode(() => authorizeKillSwitchReset(source, request, early, resetPolicy, early.approvedAt))).toBe('COOLDOWN_NOT_ELAPSED');

    const rejected = buildKillSwitchResetApproval(request, {
      approvedAt: APPROVE_AT,
      approver: { kind: 'human', id: 'human-b' },
      decision: 'REJECT',
      rationale: 'Independent review rejects the reset.',
      policy: resetPolicy,
    });
    expect(errorCode(() => authorizeKillSwitchReset(source, request, rejected, resetPolicy, APPROVE_AT))).toBe('RESET_REJECTED');
  });

  it('authorizes exactly at cooldown but cannot apply or unlock trading', () => {
    const source = healthyTrippedSource();
    const request = buildKillSwitchResetRequest(source, {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human', id: 'human-a' },
      rationale: 'The breach has cleared and the portfolio is healthy.',
      policy: resetPolicy,
    });
    const approval = buildKillSwitchResetApproval(request, {
      approvedAt: APPROVE_AT,
      approver: { kind: 'human', id: 'human-b' },
      decision: 'APPROVE',
      rationale: 'Independent review confirms recovery.',
      policy: resetPolicy,
    });
    const auth = authorizeKillSwitchReset(source, request, approval, resetPolicy, APPROVE_AT);
    expect(auth.authorizationId).toMatch(/^ksrz_[0-9a-f]{40}$/);
    expect(auth.applyAllowed).toBe(false);
    expect(auth.liveOrderAllowed).toBe(false);
    expect(auth.physicalPurchaseAllowed).toBe(false);
    expect(auth.expiresAt).toBe('2026-10-14T11:15:00.000Z');
    expect(() => verifyKillSwitchResetAuthorization(source, request, approval, resetPolicy, auth, APPROVE_AT)).not.toThrow();
  });

  it('refuses expired and tampered authorization', () => {
    const source = healthyTrippedSource();
    const request = buildKillSwitchResetRequest(source, {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human', id: 'human-a' },
      rationale: 'The breach has cleared and the portfolio is healthy.',
      policy: resetPolicy,
    });
    const approval = buildKillSwitchResetApproval(request, {
      approvedAt: APPROVE_AT,
      approver: { kind: 'human', id: 'human-b' },
      decision: 'APPROVE',
      rationale: 'Independent review confirms recovery.',
      policy: resetPolicy,
    });
    const auth = authorizeKillSwitchReset(source, request, approval, resetPolicy, APPROVE_AT);
    expect(errorCode(() => verifyKillSwitchResetAuthorization(
      source, request, approval, resetPolicy, auth, '2026-10-14T11:15:00.001Z',
    ))).toBe('AUTHORIZATION_EXPIRED');

    const tampered = structuredClone(auth);
    tampered.expiresAt = '2026-10-14T12:00:00.000Z';
    expect(errorCode(() => verifyKillSwitchResetAuthorization(
      source, request, approval, resetPolicy, tampered, APPROVE_AT,
    ))).toBe('INVALID_AUTHORIZATION');
  });
});

describe('O16 append-only governance and safety audit — RED', () => {
  it('governance rejects a stale trip request and allows one request for the current trip', async () => {
    const source = healthyTrippedSource();
    const request = buildKillSwitchResetRequest(source, {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human', id: 'human-a' },
      rationale: 'The breach has cleared and the portfolio is healthy.',
      policy: resetPolicy,
    });
    const store = await SafetyGovernanceStore.open();

    await expect(store.saveRequest(request, 'trip_' + 'f'.repeat(40))).rejects.toMatchObject({ code: 'STALE_TRIP' });
    await expect(store.saveRequest(request, source.previousKillSwitch.tripId!)).resolves.toBeUndefined();
    expect(store.all()).toHaveLength(1);
  });

  it('governance makes approval/rejection terminal and authorization requires APPROVE', async () => {
    const source = healthyTrippedSource();
    const request = buildKillSwitchResetRequest(source, {
      requestedAt: REQUEST_AT,
      requester: { kind: 'human', id: 'human-a' },
      rationale: 'The breach has cleared and the portfolio is healthy.',
      policy: resetPolicy,
    });
    const approval = buildKillSwitchResetApproval(request, {
      approvedAt: APPROVE_AT,
      approver: { kind: 'human', id: 'human-b' },
      decision: 'APPROVE',
      rationale: 'Independent review confirms recovery.',
      policy: resetPolicy,
    });
    const auth = authorizeKillSwitchReset(source, request, approval, resetPolicy, APPROVE_AT);
    const store = await SafetyGovernanceStore.open();
    await store.saveRequest(request, source.previousKillSwitch.tripId!);
    await store.saveApproval(approval);
    await expect(store.saveApproval({ ...approval, approvalId: 'ksra_' + 'f'.repeat(40) })).rejects.toMatchObject({
      code: 'TERMINAL_EXISTS',
    });
    await store.saveAuthorization(auth);
    await expect(store.saveAuthorization({ ...auth, authorizationId: 'ksrz_' + 'f'.repeat(40) })).rejects.toMatchObject({
      code: 'AUTHORIZATION_NOT_ALLOWED',
    });
  });

  it('safety audit records verified decisions and alert batches idempotently', async () => {
    const request = safetyRequest();
    const decision = evaluatePortfolioSafetyEnvelope(request);
    const batch = buildSafetyAlertBatch(decision, alertPolicy);
    const audit = await AuditLog.open();
    const service = new SafetyAuditService(audit);

    await service.recordDecision(request, decision);
    await service.recordDecision(request, decision);
    await service.recordAlertBatch(decision, batch);
    await service.recordAlertBatch(decision, batch);

    expect(audit.all().map((e) => e.type)).toEqual(['SAFETY_DECISION', 'SAFETY_ALERT_BATCH']);

    const tampered = structuredClone(decision);
    tampered.state = 'TRIPPED';
    await expect(service.recordDecision(request, tampered)).rejects.toBeDefined();
  });

  it('no O16 API can apply, clear, arm or unlatch the O15 switch', async () => {
    const store = await SafetyGovernanceStore.open();
    expect('resetKillSwitch' in store).toBe(false);
    expect('clearKillSwitch' in store).toBe(false);
    expect('armKillSwitch' in store).toBe(false);
    expect('unlatchKillSwitch' in store).toBe(false);
  });
});
