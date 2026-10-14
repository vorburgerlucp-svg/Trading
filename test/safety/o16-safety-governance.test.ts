import { describe, expect, it } from 'vitest';
import { chf } from '../../src/money/money.js';
import {
  authorizeResetRequest,
  createResetAuthorizationRequest,
  createSafetyAlertBatch,
  createSafetyAuditEvent,
  SafetyAuditStore,
  SafetyGovernanceError,
  validateSafetyGovernanceArtifacts,
} from '../../src/safety/safety-governance.js';
import type {
  KillSwitchState,
  PortfolioSafetyDecision,
} from '../../src/safety/portfolio-safety-envelope.js';

const TRIGGER = 'a'.repeat(64);
const EVIDENCE = 'b'.repeat(64);
const REQUESTED = '2026-10-14T14:00:00.000Z';
const APPROVED = '2026-10-14T14:05:00.000Z';

function tripped(): KillSwitchState {
  return {
    version: 'portfolio-kill-switch:v1',
    status: 'TRIPPED',
    tripId: 'trip_' + TRIGGER.slice(0, 40),
    trippedAt: '2026-10-14T13:55:00.000Z',
    reasons: ['daily loss limit reached'],
    triggeringDecisionFingerprint: TRIGGER,
  };
}

function decision(): PortfolioSafetyDecision {
  return {
    decisionId: 'pse_' + 'c'.repeat(40),
    engineVersion: 'portfolio-safety-envelope:v1',
    inputFingerprint: 'd'.repeat(64),
    asOf: '2026-10-14T13:55:00.000Z',
    state: 'TRIPPED',
    canIncreaseRisk: false,
    canReduceRisk: true,
    liveOrderAllowed: false,
    physicalPurchaseAllowed: false,
    metrics: {
      adjustedCurrentNetWorthChf: chf(900),
      adjustedDailyPnlChf: chf(-100),
      adjustedDailyLossChf: chf(100),
      adjustedDailyLossBp: 1000,
      realizedTradingPnlTodayChf: chf(-100),
      realizedTradingLossChf: chf(100),
      intradayDrawdownChf: chf(100),
      intradayDrawdownBp: 1000,
      grossExposureChf: chf(0),
      grossExposureBp: 0,
      maximumPositionExposureBp: 0,
      openPositionCount: 0,
    },
    hardBreachReasons: ['daily loss limit reached'],
    capacityBlockReasons: [],
    dataHoldReasons: [],
    alerts: [
      { code: 'DAILY_LOSS_LIMIT', severity: 'trip', reason: 'daily loss limit reached' },
      { code: 'KILL_SWITCH_LATCHED', severity: 'trip', reason: 'kill switch latched' },
    ],
    killSwitch: tripped(),
    sourceFingerprints: {
      portfolio: '1'.repeat(64),
      riskDay: '2'.repeat(64),
      previousKillSwitch: '3'.repeat(64),
      policy: '4'.repeat(64),
    },
  };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof SafetyGovernanceError ? error.code : undefined;
  }
}

describe('O16 safety governance', () => {
  it('creates deterministic alert batches from the O15 decision without adding execution authority', () => {
    const first = createSafetyAlertBatch(decision());
    const second = createSafetyAlertBatch(decision());

    expect(first).toEqual(second);
    expect(first.batchId).toMatch(/^sab_[0-9a-f]{40}$/);
    expect(first.killSwitchStatus).toBe('TRIPPED');
    expect(first.tripId).toBe(tripped().tripId);
    expect(first.alerts).toHaveLength(2);
    expect('execute' in first).toBe(false);
    expect('unlock' in first).toBe(false);
  });

  it('creates a reset request bound to the persisted trip and recovery evidence', () => {
    const request = createResetAuthorizationRequest(tripped(), {
      requestedAt: REQUESTED,
      requesterId: 'risk-owner-1',
      recoveryEvidenceHash: EVIDENCE,
      justification: 'Pricing recovered and the loss source has been reviewed.',
    });

    expect(request.requestId).toMatch(/^rar_[0-9a-f]{40}$/);
    expect(request.tripId).toBe(tripped().tripId);
    expect(request.triggeringDecisionFingerprint).toBe(TRIGGER);
    expect(request.recoveryEvidenceHash).toBe(EVIDENCE);
  });

  it('requires a distinct human approver and keeps authorization non-executing', () => {
    const request = createResetAuthorizationRequest(tripped(), {
      requestedAt: REQUESTED,
      requesterId: 'risk-owner-1',
      recoveryEvidenceHash: EVIDENCE,
      justification: 'Pricing recovered and the loss source has been reviewed.',
    });

    expect(
      errorCode(() =>
        authorizeResetRequest(tripped(), request, {
          approverId: 'risk-owner-1',
          approvedAt: APPROVED,
        }),
      ),
    ).toBe('FOUR_EYES_REQUIRED');

    const authorization = authorizeResetRequest(tripped(), request, {
      approverId: 'risk-owner-2',
      approvedAt: APPROVED,
    });

    expect(authorization.authorizationId).toMatch(/^raa_[0-9a-f]{40}$/);
    expect(authorization.authorizationOnly).toBe(true);
    expect(authorization.resetExecuted).toBe(false);
    expect(authorization.liveTradingUnlocked).toBe(false);
  });

  it('rejects authorization if the persisted trip changed', () => {
    const request = createResetAuthorizationRequest(tripped(), {
      requestedAt: REQUESTED,
      requesterId: 'risk-owner-1',
      recoveryEvidenceHash: EVIDENCE,
      justification: 'Pricing recovered and the loss source has been reviewed.',
    });

    const different: KillSwitchState = {
      ...tripped(),
      tripId: 'trip_' + 'e'.repeat(40),
      triggeringDecisionFingerprint: 'e'.repeat(64),
    };

    expect(
      errorCode(() =>
        authorizeResetRequest(different, request, {
          approverId: 'risk-owner-2',
          approvedAt: APPROVED,
        }),
      ),
    ).toBe('TRIP_MISMATCH');
  });

  it('records alert, request and authorization in a hash-chained append-only audit', async () => {
    const batch = createSafetyAlertBatch(decision());
    const request = createResetAuthorizationRequest(tripped(), {
      requestedAt: REQUESTED,
      requesterId: 'risk-owner-1',
      recoveryEvidenceHash: EVIDENCE,
      justification: 'Pricing recovered and the loss source has been reviewed.',
    });
    const authorization = authorizeResetRequest(tripped(), request, {
      approverId: 'risk-owner-2',
      approvedAt: APPROVED,
    });

    const store = await SafetyAuditStore.open();
    const events = [
      createSafetyAuditEvent('2026-10-14T13:56:00.000Z', { kind: 'ALERT_BATCH', batch }),
      createSafetyAuditEvent(REQUESTED, { kind: 'RESET_REQUESTED', request }),
      createSafetyAuditEvent(APPROVED, { kind: 'RESET_AUTHORIZED', authorization }),
    ];

    for (const event of events) await store.append(event);

    expect(store.all()).toEqual(events);
    expect(store.headHash).toMatch(/^[0-9a-f]{64}$/);

    await store.append(events[2]!);
    expect(store.all()).toHaveLength(3);
  });

  it('exports no reset execution, clear, arm, unlatch or live-unlock API', async () => {
    const mod = await import('../../src/safety/safety-governance.js');
    expect(
      Object.keys(mod).filter((name) => /execute.*reset|clear|unlatch|unlock.*live|armkill|resetkillswitch/i.test(name)),
    ).toEqual([]);

    const store = await SafetyAuditStore.open();
    expect('reset' in store).toBe(false);
    expect('clear' in store).toBe(false);
    expect('arm' in store).toBe(false);
    expect('execute' in store).toBe(false);
  });

  it('pins artifact identity formats', () => {
    const batch = createSafetyAlertBatch(decision());
    const request = createResetAuthorizationRequest(tripped(), {
      requestedAt: REQUESTED,
      requesterId: 'risk-owner-1',
      recoveryEvidenceHash: EVIDENCE,
      justification: 'Pricing recovered and the loss source has been reviewed.',
    });
    const authorization = authorizeResetRequest(tripped(), request, {
      approverId: 'risk-owner-2',
      approvedAt: APPROVED,
    });

    expect(() => validateSafetyGovernanceArtifacts({ batch, request, authorization })).not.toThrow();
  });
});
