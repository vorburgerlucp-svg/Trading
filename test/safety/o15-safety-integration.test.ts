import { describe, expect, it } from 'vitest';
import { accounts } from '../../src/capital/accounts.js';
import { chf } from '../../src/money/money.js';
import { InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import {
  PORTFOLIO_KILL_SWITCH_VERSION,
  PORTFOLIO_SAFETY_POLICY_VERSION,
  type KillSwitchState,
  type PortfolioSafetyPolicy,
} from '../../src/safety/portfolio-safety-envelope.js';
import {
  PortfolioKillSwitchStore,
  PortfolioKillSwitchStoreError,
} from '../../src/safety/portfolio-kill-switch-store.js';
import {
  RISK_DAY_CHECKPOINT_VERSION,
  RiskDayTracker,
  type RiskDayCheckpoint,
} from '../../src/safety/risk-day-tracker.js';
import { PortfolioSafetyService } from '../../src/safety/portfolio-safety-service.js';
import { newEngine, policy as capitalPolicy } from '../helpers.js';

const DAY_START = '2026-10-14T00:00:00.000Z';
const NOON = '2026-10-14T12:00:00.000Z';
const LATER = '2026-10-14T13:00:00.000Z';

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

function trip(fingerprint = 'e'.repeat(64)): KillSwitchState {
  return {
    version: PORTFOLIO_KILL_SWITCH_VERSION,
    status: 'TRIPPED',
    tripId: 'trip_' + fingerprint.slice(0, 40),
    trippedAt: NOON,
    reasons: ['fixture breach'],
    triggeringDecisionFingerprint: fingerprint,
  };
}

describe('O15 trusted integration layer', () => {
  it('derives external flows from CapitalEngine snapshots instead of caller-provided flow numbers', async () => {
    const { engine } = await newEngine(capitalPolicy(), DAY_START);
    await engine.deposit({
      id: 'initial-capital',
      occurredAt: DAY_START,
      to: accounts.bank('main'),
      amountChf: chf(1000),
    });

    const tracker = await RiskDayTracker.open(DAY_START);
    await tracker.capture(engine, { asOf: DAY_START });

    await engine.deposit({
      id: 'midday-deposit',
      occurredAt: NOON,
      to: accounts.bank('main'),
      amountChf: chf(100),
    });
    await tracker.capture(engine, { asOf: NOON });

    const summary = tracker.summary();
    expect(summary.startNetWorthChf).toBe(chf(1000));
    expect(summary.netExternalFlowsTodayChf).toBe(chf(100));
    expect(summary.peakAdjustedNetWorthChf).toBe(chf(1000));
    expect(summary.realizedTradingPnlTodayChf).toBe(chf(0));
    expect(summary.sourceLedgerHeadHash).toBe(engine.ledger.head().hash);
    expect(summary.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires the append-only risk day to begin exactly at dayStartedAt and advances monotonically', async () => {
    const { engine } = await newEngine(capitalPolicy(), DAY_START);
    await engine.deposit({
      id: 'initial',
      occurredAt: DAY_START,
      to: accounts.bank('main'),
      amountChf: chf(1000),
    });

    const tracker = await RiskDayTracker.open(DAY_START);
    await expect(tracker.capture(engine, { asOf: NOON })).rejects.toMatchObject({ code: 'INVALID_CAPTURE' });

    await tracker.capture(engine, { asOf: DAY_START });
    await tracker.capture(engine, { asOf: NOON });
    await expect(tracker.capture(engine, { asOf: '2026-10-14T11:00:00.000Z' })).rejects.toMatchObject({
      code: 'INVALID_CAPTURE',
    });
  });

  it('refuses a malformed stored risk-day history on open', async () => {
    const store = new InMemoryAppendOnlyStore<RiskDayCheckpoint>();
    const malformed: RiskDayCheckpoint = {
      version: RISK_DAY_CHECKPOINT_VERSION,
      dayId: '2026-10-14',
      dayStartedAt: DAY_START,
      asOf: NOON,
      totalNetWorthChf: chf(1000),
      netContributionsChf: chf(1000),
      realizedTradingPnlCumulativeChf: chf(0),
      ledgerHeadHash: 'a'.repeat(64),
      portfolioFingerprint: 'b'.repeat(64),
    };
    // Seed through the generic append-only contract to simulate a semantically invalid but hash-valid history.
    const { AppendOnlyLog } = await import('../../src/persistence/append-only-log.js');
    const raw = await AppendOnlyLog.open<RiskDayCheckpoint>('seed', store);
    await raw.append('rdc_' + '1'.repeat(40), malformed);

    await expect(RiskDayTracker.open(DAY_START, store)).rejects.toMatchObject({ code: 'INVALID_DAY' });
  });

  it('stores one monotonic trip and exposes no reset path', async () => {
    const store = await PortfolioKillSwitchStore.open();
    expect(store.current().status).toBe('ARMED');
    expect('reset' in store).toBe(false);
    expect('clear' in store).toBe(false);
    expect('arm' in store).toBe(false);

    const first = trip();
    expect((await store.latch(first)).tripId).toBe(first.tripId);
    expect(store.current()).toEqual(first);

    const second = trip('f'.repeat(64));
    await expect(store.latch(second)).rejects.toSatisfy(
      (error: unknown) => error instanceof PortfolioKillSwitchStoreError && error.code === 'ALREADY_TRIPPED',
    );
    expect(store.current()).toEqual(first);
  });

  it('the safety service sources the previous switch from append-only storage and preserves the first trip', async () => {
    const { engine } = await newEngine(capitalPolicy(), DAY_START);
    await engine.deposit({
      id: 'initial',
      occurredAt: DAY_START,
      to: accounts.bank('main'),
      amountChf: chf(1000),
    });

    const tracker = await RiskDayTracker.open(DAY_START);
    await tracker.capture(engine, { asOf: DAY_START });
    const switchStore = await PortfolioKillSwitchStore.open();
    const service = new PortfolioSafetyService(tracker, switchStore);

    await engine.transfer({
      id: 'loss-fee',
      occurredAt: NOON,
      from: accounts.bank('main'),
      to: accounts.brokerCash('paper'),
      amountChf: chf(100),
      feeChf: chf(100),
      feeKind: 'trading',
    });

    const first = await service.evaluateCurrent(
      engine,
      { asOf: NOON },
      safetyPolicy({
        maxAdjustedDailyLossChf: chf(100),
        maxAdjustedDailyLossBp: 9999,
        maxRealizedTradingLossChf: chf(999),
        maxIntradayDrawdownChf: chf(999),
        maxIntradayDrawdownBp: 9999,
      }),
    );
    expect(first.state).toBe('TRIPPED');
    expect(switchStore.current().tripId).toBe(first.killSwitch.tripId);

    const originalTripId = first.killSwitch.tripId;
    const later = await service.evaluateCurrent(
      engine,
      { asOf: LATER },
      safetyPolicy({
        maxAdjustedDailyLossChf: chf(200),
        maxAdjustedDailyLossBp: 9999,
        maxRealizedTradingLossChf: chf(999),
        maxIntradayDrawdownChf: chf(999),
        maxIntradayDrawdownBp: 9999,
      }),
    );

    expect(later.hardBreachReasons).toEqual([]);
    expect(later.state).toBe('TRIPPED');
    expect(later.killSwitch.tripId).toBe(originalTripId);
    expect(later.canIncreaseRisk).toBe(false);
    expect(later.canReduceRisk).toBe(true);
    expect(later.liveOrderAllowed).toBe(false);
  });
});
