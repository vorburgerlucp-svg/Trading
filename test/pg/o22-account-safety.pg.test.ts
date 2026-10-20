// O22 B2 variant A on a real PostgreSQL: the risk day of the demo account safety source is one append-only log shared by every
// process. A second process and a restarted process see the same day start and peak, so a restart cannot reset a drawdown.
// Evidence released for this module only (TEST ONLY); the pnl bodies are REFERENCE_SCHEMA test data. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/broker/etoro/execution/demo-account-evidence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/broker/etoro/execution/demo-account-evidence.js')>();
  return { ...actual, DEMO_ACCOUNT_VALUATION_EVIDENCE: Object.freeze({ ...actual.DEMO_ACCOUNT_VALUATION_EVIDENCE, nonEmptyPnlLiveObserved: true, evidenceRef: 'TEST-ONLY' }) };
});
import { EtoroDemoAccountSafetySource, type DemoAccountValuationRecord } from '../../src/broker/etoro/execution/demo-account-safety.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { PortfolioKillSwitchStore } from '../../src/safety/portfolio-kill-switch-store.js';
import type { KillSwitchState } from '../../src/safety/portfolio-safety-envelope.js';
import { FixtureEtoroTransport } from '../broker/etoro/o20-fixture.js';
import { schemaPnl } from '../broker/etoro/o21a1-pnl-fixture.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

async function process_(pool: PgPool, credit: number) {
  const transport = new FixtureEtoroTransport();
  transport.response = { status: 200, body: schemaPnl({ credit }) };
  const valuations = await AppendOnlyLog.open<DemoAccountValuationRecord>('etoro-demo-account-valuations', await PostgresAppendOnlyStore.open<DemoAccountValuationRecord>(pool, 'etoro-demo-account-valuations'));
  const source = new EtoroDemoAccountSafetySource({
    transport,
    killSwitch: await PortfolioKillSwitchStore.open(new InMemoryAppendOnlyStore<KillSwitchState>()),
    valuations,
    nexusPositionIds: async () => new Set(),
  });
  return { source, transport };
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 demo account risk day on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  it('two processes and a restart share one day start and one peak: a restart does not reset the drawdown', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const a = await process_(db.pool, 10000);
    expect((await a.source.current('2026-10-16T08:00:00.000Z'))?.state).toBe('NORMAL');
    const b = await process_(db.extraPool(), 10090);
    expect((await b.source.current('2026-10-16T09:00:00.000Z'))?.riskDay).toEqual({ dayId: '2026-10-16', startEquityUsd: '10000', peakEquityUsd: '10090' });
    const restarted = await process_(db.extraPool(), 9985);
    const after = await restarted.source.current('2026-10-16T10:00:00.000Z');
    expect(after?.riskDay).toEqual({ dayId: '2026-10-16', startEquityUsd: '10000', peakEquityUsd: '10090' });
    expect(after?.hardBreachReasons).toEqual(['DRAWDOWN_LIMIT']);
    expect(after?.canIncreaseRisk).toBe(false);
    const rows = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'etoro-demo-account-valuations'");
    expect(rows.rows[0]?.n).toBe(3);
    const text = await db.pool.query<{ t: string }>("SELECT string_agg(payload::text, ' ') AS t FROM append_only_records WHERE log_name = 'etoro-demo-account-valuations'");
    expect(text.rows[0]?.t).not.toMatch(/positionID|cid|credit/i);
  });
});
