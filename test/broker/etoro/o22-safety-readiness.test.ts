// O22: the demo safety readiness report. It is never a decision. In this build (evidence not released) it is never connected, the
// account values are never reported as verified, and stale or unknown inputs are never verified.
import { describe, expect, it } from 'vitest';
import { assessDemoSafetyReadiness } from '../../../src/broker/etoro/execution/demo-safety-readiness.js';
import type { EtoroSnapshotView } from '../../../src/broker/etoro/etoro-broker-service.js';
import type { KillSwitchState } from '../../../src/safety/portfolio-safety-envelope.js';
import { trippedKillSwitch } from './o21-fixture.js';

const NOW = '2026-10-20T10:00:00.000Z';
const ARMED: KillSwitchState = { version: 'portfolio-kill-switch:v1', status: 'ARMED', tripId: null, trippedAt: null, reasons: [], triggeringDecisionFingerprint: null };
const FRESH = { connection: 'connected', lastSuccessfulSync: '2026-10-20T09:59:00.000Z' };

function snapshot(freshness: 'fresh' | 'stale' = 'fresh'): EtoroSnapshotView {
  return {
    snapshotId: 'esnap_x', observedAt: '2026-10-20T09:59:00.000Z', retrievedAt: '2026-10-20T09:59:00.000Z', freshness,
    content: { coverage: { cash: 'not_read', positions: 'documented_schema', openOrders: 'verified_empty', accountIdentity: 'not_observed' } },
  } as unknown as EtoroSnapshotView;
}

function statusOf(r: ReturnType<typeof assessDemoSafetyReadiness>): Record<string, string> {
  return Object.fromEntries(r.items.map((i) => [i.input, i.status]));
}

describe('O22 demo safety readiness (evidence not released in this build)', () => {
  it('source wired, fresh sync, armed switch: still not connected; the account values are not verified', () => {
    const r = assessDemoSafetyReadiness({ now: NOW, broker: FRESH, snapshot: snapshot(), killSwitch: ARMED, maxSyncAgeMs: 300_000, source: { outcome: 'no_evidence', at: NOW } });
    expect(r.connected).toBe(false);
    expect(r.reasons).toEqual(['PORTFOLIO_SAFETY_NOT_CONNECTED', 'DEMO_PNL_NONEMPTY_NOT_LIVE_OBSERVED']);
    expect(statusOf(r)).toEqual({
      accountContext: 'operator_confirmed',
      valuationEvidence: 'not_verified',
      positionsAndOrders: 'verified',
      grossExposure: 'not_verified',
      availableFunds: 'not_verified',
      drawdownAndLossLimits: 'not_verified',
      dataFreshness: 'verified',
      killSwitch: 'verified',
    });
  });

  it('without a wired source it is not connected either', () => {
    expect(assessDemoSafetyReadiness({ now: NOW, broker: FRESH, snapshot: snapshot(), killSwitch: ARMED, maxSyncAgeMs: 300_000, source: null }).connected).toBe(false);
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
