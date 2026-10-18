// O22 B2 variant A: the demo account valuation (official guide formulas over /demo/pnl), the safety decision over it, and the source
// in this build (evidence record unmocked: two non-empty /demo/pnl observations recorded on 2026-10-18). Fixture bodies are
// REFERENCE_SCHEMA test data, NOT a live response.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDemoPnlValuationInput } from '../../../src/broker/etoro/etoro-pnl-validation.js';
import { DEMO_ACCOUNT_VALUATION_EVIDENCE } from '../../../src/broker/etoro/execution/demo-account-evidence.js';
import {
  DEMO_ACCOUNT_SAFETY_POLICY,
  EtoroDemoAccountSafetySource,
  evaluateDemoAccountSafety,
  valueDemoAccount,
  type DemoAccountValuationRecord,
  type DemoRiskDay,
} from '../../../src/broker/etoro/execution/demo-account-safety.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { PortfolioKillSwitchStore } from '../../../src/safety/portfolio-kill-switch-store.js';
import type { KillSwitchState } from '../../../src/safety/portfolio-safety-envelope.js';
import { FixtureEtoroTransport } from './o20-fixture.js';
import { trippedKillSwitch } from './o21-fixture.js';
import { schemaPnl, schemaPnlOrder, schemaPnlOrderForOpen, schemaPnlPosition } from './o21a1-pnl-fixture.js';

const AS_OF = '2026-10-20T10:00:00.000Z';
const ARMED: KillSwitchState = { version: 'portfolio-kill-switch:v1', status: 'ARMED', tripId: null, trippedAt: null, reasons: [], triggeringDecisionFingerprint: null };
const NONE = new Set<number>();
/** The documented example position (positionID 2150896073, amount 100, leverage 1), with a stated pnL. */
const manualPosition = (pnL = 0) => schemaPnlPosition({ unrealizedPnL: { pnL, closeRate: 2400, timestamp: '2026-10-20T09:59:58Z' } });

function decide(body: unknown, riskDay: DemoRiskDay | null, options: { killSwitch?: KillSwitchState; nexus?: ReadonlySet<number> } = {}) {
  const valuation = valueDemoAccount(parseDemoPnlValuationInput(body), options.nexus ?? NONE);
  return evaluateDemoAccountSafety({ asOf: AS_OF, valuation, riskDay, killSwitch: options.killSwitch ?? ARMED, policy: DEMO_ACCOUNT_SAFETY_POLICY });
}

const flatDay = (equity: string): DemoRiskDay => ({ dayId: '2026-10-20', startEquityUsd: equity, peakEquityUsd: equity });

describe('O22 demo account valuation: the official guide formulas', () => {
  it('one position: available cash = credit; invested = amount; equity = cash + invested + pnL; exposure = |amount × leverage + pnL|', () => {
    const v = valueDemoAccount(parseDemoPnlValuationInput(schemaPnl({ positions: [schemaPnlPosition()] })), NONE);
    expect(v).toEqual({
      kind: 'complete',
      values: {
        availableCashUsd: '10000.5', totalInvestedUsd: '100', unrealizedPnlUsd: '100.25', equityUsd: '10200.75', grossExposureUsd: '200.25',
        positions: 1, pendingOrders: 0, nexusPositions: 0, externalPositions: 1, externalExposureUsd: '200.25',
      },
    });
  });

  it('pending orders reduce available cash and count as invested and exposure; the external costs of ordersForOpen are invested', () => {
    const v = valueDemoAccount(parseDemoPnlValuationInput(schemaPnl({ positions: [schemaPnlPosition()], orders: [schemaPnlOrder()], ordersForOpen: [schemaPnlOrderForOpen()] })), NONE);
    if (v.kind !== 'complete') throw new Error('expected a complete valuation');
    expect(v.values.availableCashUsd).toBe('8000.5');
    expect(v.values.totalInvestedUsd).toBe('2105');
    expect(v.values.equityUsd).toBe('10205.75');
    expect(v.values.grossExposureUsd).toBe('4200.25');
    expect(v.values.pendingOrders).toBe(2);
  });

  it('a position NEXUS opened is counted as NEXUS, every other one as external; nothing is subtracted', () => {
    const v = valueDemoAccount(parseDemoPnlValuationInput(schemaPnl({ positions: [schemaPnlPosition()] })), new Set([2150896073]));
    if (v.kind !== 'complete') throw new Error('expected a complete valuation');
    expect([v.values.nexusPositions, v.values.externalPositions, v.values.externalExposureUsd, v.values.grossExposureUsd]).toEqual([1, 0, '0', '200.25']);
  });

  it('a value a formula needs and the response does not state is a data hold, never zero', () => {
    const hold = (body: unknown) => valueDemoAccount(parseDemoPnlValuationInput(body), NONE);
    expect(hold(schemaPnl({ positions: [schemaPnlPosition({ unrealizedPnL: null })] }))).toEqual({ kind: 'incomplete', dataHoldReasons: ['POSITION_PNL_UNKNOWN'] });
    expect(hold(schemaPnl({ positions: [schemaPnlPosition({ unrealizedPnL: { closeRate: 1 } })] }))).toEqual({ kind: 'incomplete', dataHoldReasons: ['POSITION_PNL_UNKNOWN'] });
    expect(hold(schemaPnl({ ordersForOpen: [schemaPnlOrderForOpen({ totalExternalCosts: undefined })] }))).toEqual({ kind: 'incomplete', dataHoldReasons: ['ORDER_EXTERNAL_COSTS_UNKNOWN'] });
    expect(hold(schemaPnl({ accountCurrencyId: undefined }))).toEqual({ kind: 'incomplete', dataHoldReasons: ['ACCOUNT_CURRENCY_NOT_USD_OR_UNKNOWN'] });
    expect(hold(schemaPnl({ accountCurrencyId: 2 }))).toEqual({ kind: 'incomplete', dataHoldReasons: ['ACCOUNT_CURRENCY_NOT_USD_OR_UNKNOWN'] });
  });

  it('the parser stays strict: copy trading, a missing credit or a string where a number belongs is refused', () => {
    expect(() => parseDemoPnlValuationInput(schemaPnl({ mirrors: [{ mirrorID: 1 }] }))).toThrow(/mirrors/);
    expect(() => parseDemoPnlValuationInput(schemaPnl({ credit: undefined }))).toThrow(/credit/);
    expect(() => parseDemoPnlValuationInput(schemaPnl({ credit: '10000' }))).toThrow(/credit/);
    expect(() => parseDemoPnlValuationInput(schemaPnl({ ordersForOpen: [schemaPnlOrderForOpen({ totalExternalCosts: '5' })] }))).toThrow(/totalExternalCosts/);
  });
});

describe('O22 demo account safety decision', () => {
  it('an empty account within every limit is NORMAL', () => {
    const d = decide(schemaPnl(), flatDay('10000.5'));
    expect(d.state).toBe('NORMAL');
    expect(d.canIncreaseRisk).toBe(true);
    expect([d.hardBreachReasons, d.capacityBlockReasons, d.dataHoldReasons]).toEqual([[], [], []]);
    expect(d.liveOrderAllowed).toBe(false);
  });

  it('the hand-opened 100 USD position counts: the one 100 USD cycle open does not fit, so it stays refused', () => {
    const d = decide(schemaPnl({ positions: [manualPosition(0)] }), flatDay('10100.5'));
    expect(d.state).toBe('CAPACITY_BLOCK');
    expect(d.canIncreaseRisk).toBe(false);
    expect(d.capacityBlockReasons).toEqual(['ACCOUNT_EXPOSURE_LIMIT', 'ACCOUNT_POSITION_LIMIT']);
    expect(d.values?.externalPositions).toBe(1);
  });

  it('a pending order alone also takes the one slot', () => {
    const d = decide(schemaPnl({ orders: [schemaPnlOrder({ amount: 10, leverage: 1 })] }), flatDay('10000.5'));
    expect(d.capacityBlockReasons).toEqual(expect.arrayContaining(['ACCOUNT_POSITION_LIMIT']));
  });

  it('loss and drawdown limits trip; equity not positive trips; a tripped kill switch trips', () => {
    expect(decide(schemaPnl(), { dayId: '2026-10-20', startEquityUsd: '10100.5', peakEquityUsd: '10100.5' }).hardBreachReasons).toEqual(['DAILY_LOSS_LIMIT', 'DRAWDOWN_LIMIT']);
    expect(decide(schemaPnl(), { dayId: '2026-10-20', startEquityUsd: '10000.5', peakEquityUsd: '10150' }).hardBreachReasons).toEqual(['DRAWDOWN_LIMIT']);
    expect(decide(schemaPnl(), { dayId: '2026-10-20', startEquityUsd: '10050', peakEquityUsd: '10050' }).state).toBe('NORMAL');
    const broke = decide(schemaPnl({ credit: -1 }), flatDay('-1'));
    expect(broke.hardBreachReasons).toContain('EQUITY_NOT_POSITIVE');
    const tripped = decide(schemaPnl(), flatDay('10000.5'), { killSwitch: trippedKillSwitch() });
    expect(tripped.state).toBe('TRIPPED');
    expect(tripped.hardBreachReasons).toEqual(['KILL_SWITCH_TRIPPED']);
  });

  it('available cash below the order is a capacity block', () => {
    expect(decide(schemaPnl({ credit: 99.99 }), flatDay('99.99')).capacityBlockReasons).toEqual(['AVAILABLE_CASH_BELOW_ORDER']);
  });

  it('an incomplete valuation or an unknown risk day is a DATA_HOLD that cannot increase risk', () => {
    const d = decide(schemaPnl({ positions: [schemaPnlPosition({ unrealizedPnL: null })] }), null);
    expect(d.state).toBe('DATA_HOLD');
    expect(d.canIncreaseRisk).toBe(false);
    expect(d.values).toBeNull();
    expect(decide(schemaPnl(), null).dataHoldReasons).toEqual(['RISK_DAY_UNKNOWN']);
  });

  it('the policy is a frozen code constant: the cycle limits applied to the whole account', () => {
    expect(Object.isFrozen(DEMO_ACCOUNT_SAFETY_POLICY)).toBe(true);
    expect(DEMO_ACCOUNT_SAFETY_POLICY).toMatchObject({ maxAccountGrossExposureUsd: '100', maxAccountPositionsAndOrders: 1, orderReserveUsd: '100' });
  });
});

describe('O22 demo account safety source in this build: evidence recorded (2026-10-18)', () => {
  it('the evidence record cites the two non-empty /demo/pnl reports, and both exist in docs/evidence', () => {
    expect(DEMO_ACCOUNT_VALUATION_EVIDENCE.nonEmptyPnlLiveObserved).toBe(true);
    expect(Object.isFrozen(DEMO_ACCOUNT_VALUATION_EVIDENCE)).toBe(true);
    const refs = String(DEMO_ACCOUNT_VALUATION_EVIDENCE.evidenceRef).split('; ');
    expect(refs).toEqual(['docs/evidence/O22_etoro_demo_pnl_observation_2026-10-18.json', 'docs/evidence/O22_etoro_demo_pnl_observation_2026-10-18_2.json']);
    const [first, second] = refs.map((ref) => JSON.parse(readFileSync(ref, 'utf8')) as Record<string, any>);
    expect(first!.parser.outcome).toBe('accepted');
    expect(first!.containers.positions.count).toBe(1);
    expect(second!.parser.outcome).toBe('accepted');
    expect(second!.valuationEvidence.checks).toEqual({ allPositionPnlFiniteNumbers: true, accountCurrencyIsUsd: true });
    expect(second!.valuationEvidence.accountCurrencyId).toEqual({ present: true, kind: 'integer', code: 1 });
  });

  it('current() now reads exactly once and decides; the hand-opened position still blocks the cycle open (nothing is released)', async () => {
    const transport = new FixtureEtoroTransport();
    transport.response = { status: 200, body: schemaPnl({ positions: [manualPosition(-1)] }) };
    const source = new EtoroDemoAccountSafetySource({
      transport,
      killSwitch: await PortfolioKillSwitchStore.open(new InMemoryAppendOnlyStore<KillSwitchState>()),
      valuations: await AppendOnlyLog.open<DemoAccountValuationRecord>('etoro-demo-account-valuations', new InMemoryAppendOnlyStore()),
      nexusPositionIds: async () => NONE,
    });
    const decision = await source.current(AS_OF);
    expect(transport.calls).toEqual(['pnl.demo']);
    expect(decision?.state).toBe('CAPACITY_BLOCK');
    expect(decision?.canIncreaseRisk).toBe(false);
    expect(decision?.liveOrderAllowed).toBe(false);
  });
});
