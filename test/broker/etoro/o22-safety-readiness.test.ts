// O22: the demo safety readiness report. It is never a safety decision: connected is always false in this build, and an unknown,
// unverified or stale input is never reported as verified.
import { describe, expect, it } from 'vitest';
import { assessDemoSafetyReadiness } from '../../../src/broker/etoro/execution/demo-safety-readiness.js';
import type { EtoroSnapshotView } from '../../../src/broker/etoro/etoro-broker-service.js';
import type { KillSwitchState } from '../../../src/safety/portfolio-safety-envelope.js';
import { trippedKillSwitch } from './o21-fixture.js';

const NOW = '2026-10-20T10:00:00.000Z';
const ARMED: KillSwitchState = { version: 'portfolio-kill-switch:v1', status: 'ARMED', tripId: null, trippedAt: null, reasons: [], triggeringDecisionFingerprint: null };

function snapshot(freshness: 'fresh' | 'stale' = 'fresh'): EtoroSnapshotView {
  return {
    snapshotId: 'esnap_x', observedAt: '2026-10-20T09:59:00.000Z', retrievedAt: '2026-10-20T09:59:00.000Z', freshness,
    content: { coverage: { cash: 'not_read', positions: 'documented_schema', openOrders: 'verified_empty', accountIdentity: 'not_observed' } },
  } as unknown as EtoroSnapshotView;
}

function statusOf(r: ReturnType<typeof assessDemoSafetyReadiness>): Record<string, string> {
  return Object.fromEntries(r.items.map((i) => [i.input, i.status]));
}

describe('O22 demo safety readiness', () => {
  it('the best case today: fresh sync, armed kill switch; still not connected, and the account values stay unverified', () => {
    const r = assessDemoSafetyReadiness({ now: NOW, broker: { connection: 'connected', lastSuccessfulSync: '2026-10-20T09:59:00.000Z' }, snapshot: snapshot(), killSwitch: ARMED, maxSyncAgeMs: 300_000 });
    expect(r.connected).toBe(false);
    expect(r.gateReason).toBe('PORTFOLIO_SAFETY_NOT_CONNECTED');
    expect(statusOf(r)).toEqual({
      accountContext: 'not_verified',
      positionsAndOrders: 'verified',
      grossExposure: 'not_available',
      availableFunds: 'not_verified',
      drawdownAndLossLimits: 'not_available',
      dataFreshness: 'verified',
      killSwitch: 'verified',
    });
  });

  it('no sync, a stale sync, or a stale snapshot is stale, never verified', () => {
    for (const input of [
      { broker: { connection: 'not_connected', lastSuccessfulSync: null }, snapshot: null },
      { broker: { connection: 'connected', lastSuccessfulSync: '2026-10-20T09:50:00.000Z' }, snapshot: snapshot() },
      { broker: { connection: 'connected', lastSuccessfulSync: '2026-10-20T09:59:00.000Z' }, snapshot: snapshot('stale') },
      { broker: { connection: 'error', lastSuccessfulSync: '2026-10-20T09:59:00.000Z' }, snapshot: snapshot() },
    ]) {
      const s = statusOf(assessDemoSafetyReadiness({ now: NOW, killSwitch: ARMED, maxSyncAgeMs: 300_000, ...input }));
      expect(s.dataFreshness).toBe('stale');
      expect(s.positionsAndOrders).not.toBe('verified');
    }
  });

  it('a tripped kill switch is blocking', () => {
    const r = assessDemoSafetyReadiness({ now: NOW, broker: { connection: 'connected', lastSuccessfulSync: '2026-10-20T09:59:00.000Z' }, snapshot: snapshot(), killSwitch: trippedKillSwitch(), maxSyncAgeMs: 300_000 });
    expect(statusOf(r).killSwitch).toBe('blocking');
    expect(r.connected).toBe(false);
  });

  it('the runtime still passes no safety source to the execution service', async () => {
    const { readFileSync } = await import('node:fs');
    const compose = readFileSync('src/runtime/compose.ts', 'utf8');
    expect(compose).toContain('safety: executionInput.safetyForTests ?? NO_DEMO_SAFETY_SOURCE');
    expect(compose).not.toMatch(/assessDemoSafetyReadiness/);
  });
});
