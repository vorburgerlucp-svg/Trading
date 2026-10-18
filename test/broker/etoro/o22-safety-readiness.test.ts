// O22: the demo safety readiness report in this build (evidence recorded 2026-10-18). It is never a decision. Account values are
// "verified" only from a fresh, complete decision of the source; stale or unknown inputs are never verified. The state without
// evidence is tested in o22-demo-account-safety-no-evidence.test.ts.
import { describe, expect, it } from 'vitest';
import { assessDemoSafetyReadiness } from '../../../src/broker/etoro/execution/demo-safety-readiness.js';
import { DEMO_ACCOUNT_SAFETY_POLICY, evaluateDemoAccountSafety, valueDemoAccount } from '../../../src/broker/etoro/execution/demo-account-safety.js';
import { parseDemoPnlValuationInput } from '../../../src/broker/etoro/etoro-pnl-validation.js';
import type { EtoroSnapshotView } from '../../../src/broker/etoro/etoro-broker-service.js';
import type { KillSwitchState } from '../../../src/safety/portfolio-safety-envelope.js';
import { trippedKillSwitch } from './o21-fixture.js';
import { schemaPnl } from './o21a1-pnl-fixture.js';

const NOW = '2026-10-20T10:00:00.000Z';
const ARMED: KillSwitchState = { version: 'portfolio-kill-switch:v1', status: 'ARMED', tripId: null, trippedAt: null, reasons: [], triggeringDecisionFingerprint: null };
const FRESH = { connection: 'connected', lastSuccessfulSync: '2026-10-20T09:59:00.000Z' };

function snapshot(freshness: 'fresh' | 'stale' = 'fresh'): EtoroSnapshotView {
  return {
    snapshotId: 'esnap_x', observedAt: '2026-10-20T09:59:00.000Z', retrievedAt: '2026-10-20T09:59:00.000Z', freshness,
    content: { coverage: { cash: 'not_read', positions: 'documented_schema', openOrders: 'verified_empty', accountIdentity: 'not_observed' } },
  } as unknown as EtoroSnapshotView;
}

function decisionAt(asOf: string) {
  const valuation = valueDemoAccount(parseDemoPnlValuationInput(schemaPnl()), new Set());
  return evaluateDemoAccountSafety({ asOf, valuation, riskDay: { dayId: asOf.slice(0, 10), startEquityUsd: '10000.5', peakEquityUsd: '10000.5' }, killSwitch: ARMED, policy: DEMO_ACCOUNT_SAFETY_POLICY });
}

function statusOf(r: ReturnType<typeof assessDemoSafetyReadiness>): Record<string, string> {
  return Object.fromEntries(r.items.map((i) => [i.input, i.status]));
}

describe('O22 demo safety readiness (evidence recorded)', () => {
  it('source wired, not evaluated yet: connected, evidence verified, account values not available', () => {
    const r = assessDemoSafetyReadiness({ now: NOW, broker: FRESH, snapshot: snapshot(), killSwitch: ARMED, maxSyncAgeMs: 300_000, source: { outcome: 'not_evaluated' } });
    expect(r.connected).toBe(true);
    expect(r.lastDecisionState).toBeNull();
    expect(statusOf(r)).toEqual({
      accountContext: 'operator_confirmed',
      valuationEvidence: 'verified',
      positionsAndOrders: 'verified',
      grossExposure: 'not_available',
      availableFunds: 'not_available',
      drawdownAndLossLimits: 'not_available',
      dataFreshness: 'verified',
      killSwitch: 'verified',
    });
  });

  it('a fresh complete decision verifies the account values; an old one does not', () => {
    const fresh = assessDemoSafetyReadiness({ now: NOW, broker: FRESH, snapshot: snapshot(), killSwitch: ARMED, maxSyncAgeMs: 300_000, source: { outcome: 'decision', at: NOW, decision: decisionAt('2026-10-20T09:59:30.000Z') } });
    expect(fresh.lastDecisionState).toBe('NORMAL');
    expect(statusOf(fresh)).toMatchObject({ grossExposure: 'verified', availableFunds: 'verified', drawdownAndLossLimits: 'verified' });
    const old = assessDemoSafetyReadiness({ now: NOW, broker: FRESH, snapshot: snapshot(), killSwitch: ARMED, maxSyncAgeMs: 300_000, source: { outcome: 'decision', at: NOW, decision: decisionAt('2026-10-20T09:40:00.000Z') } });
    expect(statusOf(old)).toMatchObject({ grossExposure: 'not_available', availableFunds: 'not_available', drawdownAndLossLimits: 'not_available' });
  });

  it('without a wired source it is not connected', () => {
    const r = assessDemoSafetyReadiness({ now: NOW, broker: FRESH, snapshot: snapshot(), killSwitch: ARMED, maxSyncAgeMs: 300_000, source: null });
    expect(r.connected).toBe(false);
    expect(r.reasons).toContain('PORTFOLIO_SAFETY_NOT_CONNECTED');
  });

  it('no sync, a stale sync, a stale snapshot or a broker error is stale, never verified', () => {
    for (const input of [
      { broker: { connection: 'not_connected', lastSuccessfulSync: null }, snapshot: null },
      { broker: { connection: 'connected', lastSuccessfulSync: '2026-10-20T09:50:00.000Z' }, snapshot: snapshot() },
      { broker: FRESH, snapshot: snapshot('stale') },
      { broker: { connection: 'error', lastSuccessfulSync: '2026-10-20T09:59:00.000Z' }, snapshot: snapshot() },
    ]) {
      const s = statusOf(assessDemoSafetyReadiness({ now: NOW, killSwitch: ARMED, maxSyncAgeMs: 300_000, source: null, ...input }));
      expect(s.dataFreshness).toBe('stale');
      expect(s.positionsAndOrders).not.toBe('verified');
    }
  });

  it('a read failure of the source is reported with its code; a tripped kill switch is blocking', () => {
    const r = assessDemoSafetyReadiness({ now: NOW, broker: FRESH, snapshot: snapshot(), killSwitch: trippedKillSwitch(), maxSyncAgeMs: 300_000, source: { outcome: 'read_failed', at: NOW, code: 'BROKER_TIMEOUT' } });
    expect(r.reasons).toContain('BROKER_TIMEOUT');
    expect(statusOf(r).killSwitch).toBe('blocking');
  });
});
