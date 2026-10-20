// O22: the fail-closed path of the demo account safety source without evidence. TEST ONLY: this module replaces the evidence record
// with "not observed" (the state before 2026-10-18), to keep proving that the source then answers null and sends nothing.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/broker/etoro/execution/demo-account-evidence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/broker/etoro/execution/demo-account-evidence.js')>();
  return { ...actual, DEMO_ACCOUNT_VALUATION_EVIDENCE: Object.freeze({ ...actual.DEMO_ACCOUNT_VALUATION_EVIDENCE, nonEmptyPnlLiveObserved: false, evidenceRef: null }) };
});
import { EtoroDemoAccountSafetySource, type DemoAccountValuationRecord } from '../../../src/broker/etoro/execution/demo-account-safety.js';
import { assessDemoSafetyReadiness } from '../../../src/broker/etoro/execution/demo-safety-readiness.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { PortfolioKillSwitchStore } from '../../../src/safety/portfolio-kill-switch-store.js';
import type { KillSwitchState } from '../../../src/safety/portfolio-safety-envelope.js';
import { FixtureEtoroTransport } from './o20-fixture.js';
import { schemaPnl } from './o21a1-pnl-fixture.js';

const AT = '2026-10-20T10:00:00.000Z';
const ARMED: KillSwitchState = { version: 'portfolio-kill-switch:v1', status: 'ARMED', tripId: null, trippedAt: null, reasons: [], triggeringDecisionFingerprint: null };

describe('O22 demo account safety source without evidence (evidence record mocked to "not observed")', () => {
  it('current() answers null and sends nothing, whatever the broker would answer', async () => {
    const transport = new FixtureEtoroTransport();
    transport.response = { status: 200, body: schemaPnl() };
    const source = new EtoroDemoAccountSafetySource({
      transport,
      killSwitch: await PortfolioKillSwitchStore.open(new InMemoryAppendOnlyStore<KillSwitchState>()),
      valuations: await AppendOnlyLog.open<DemoAccountValuationRecord>('etoro-demo-account-valuations', new InMemoryAppendOnlyStore()),
      nexusPositionIds: async () => new Set(),
    });
    expect(await source.current(AT)).toBeNull();
    expect(transport.calls).toEqual([]);
    expect(source.status()).toEqual({ outcome: 'no_evidence', at: AT });
  });

  it('the readiness report is then not connected, and the account values are not verified', () => {
    const r = assessDemoSafetyReadiness({ now: AT, broker: { connection: 'connected', lastSuccessfulSync: '2026-10-20T09:59:00.000Z' }, snapshot: null, killSwitch: ARMED, maxSyncAgeMs: 300_000, source: { outcome: 'no_evidence', at: AT } });
    expect(r.connected).toBe(false);
    expect(r.reasons).toEqual(['PORTFOLIO_SAFETY_NOT_CONNECTED', 'DEMO_PNL_NONEMPTY_NOT_LIVE_OBSERVED']);
    expect(Object.fromEntries(r.items.map((i) => [i.input, i.status]))).toMatchObject({ valuationEvidence: 'not_verified', grossExposure: 'not_verified', availableFunds: 'not_verified', drawdownAndLossLimits: 'not_verified' });
  });
});
