// O21 cross-process reservation on a real PostgreSQL: two services, two connection pools, two sets of AppendOnlyLog instances on
// the same database (the setup of two NEXUS processes). The second gate passes against a stale book; the reservation inside the
// PostgreSQL critical section (SELECT ... FOR UPDATE on the log row, then catch-up) refuses it. Exactly one broker write.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { DEFAULT_DEMO_EXECUTION_POLICY, type GateQuote } from '../../src/broker/etoro/execution/execution-gate.js';
import { DemoExecutionError } from '../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { CREATOR, ETORO_MSFT_ID, HUMAN, MSFT, ScriptedBroker, freshQuote, o21Fixture, openInput, orderAccepted, type Fixture, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: the write path needs the compile-time lock open for this module.
vi.mock('../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

async function pgStores(pool: PgPool): Promise<O21Stores> {
  return {
    intents: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-intents'),
    attempts: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-attempts'),
    confirmations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-broker-confirmations'),
    reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-reconciliations'),
  };
}

function hold() {
  let armed = false;
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const reachedPromise = new Promise<void>((r) => (reached = r));
  return {
    arm: () => { armed = true; },
    reached: reachedPromise,
    release: () => release(),
    source: async (): Promise<GateQuote | null> => {
      if (armed) {
        reached();
        await released;
      }
      return freshQuote();
    },
  };
}

async function approved(f: Fixture, overrides: Record<string, unknown>): Promise<string> {
  const created = await f.service.create(openInput(overrides), CREATOR);
  expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
  await f.service.approve(created.intentId, HUMAN);
  return created.intentId;
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O21 cross-process reservation on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  it('two processes, combined exposure above the limit: the stale second gate is refused by the reservation, 1 write', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const policy = { ...DEFAULT_DEMO_EXECUTION_POLICY, maxGrossExposureUsd: '1500' };
    const holdB = hold();
    const a = await o21Fixture({ stores: await pgStores(db.pool), sharedBroker: broker, policy });
    const b = await o21Fixture({ stores: await pgStores(db.extraPool()), sharedBroker: broker, policy, quoteSource: holdB.source });
    const x = await approved(a, { amount: '1000' });
    const y = await approved(b, { instrumentId: MSFT.instrumentId, etoroInstrumentId: ETORO_MSFT_ID, amount: '1000' });

    holdB.arm();
    const late = b.service.execute(y, HUMAN).catch((e: unknown) => e);
    await holdB.reached;
    broker.next(orderAccepted());
    expect((await a.service.execute(x, HUMAN)).state).toBe('SUBMITTED');
    holdB.release();
    const refused = await late;
    expect(refused).toBeInstanceOf(DemoExecutionError);
    expect((refused as DemoExecutionError).code).toBe('GATE_REFUSED');
    expect((refused as DemoExecutionError).reasons).toContain('GROSS_EXPOSURE_ABOVE_LIMIT');
    expect(broker.writes).toHaveLength(1);

    const rows = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'etoro-demo-execution-intents' AND payload->>'state' = 'SUBMITTING'");
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('two processes execute the same pair at once: exactly 1 write', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const a = await o21Fixture({ stores: await pgStores(db.pool), sharedBroker: broker });
    const b = await o21Fixture({ stores: await pgStores(db.extraPool()), sharedBroker: broker });
    const x = await approved(a, { strategyRunId: 'run-x' });
    const y = await approved(b, { strategyRunId: 'run-y', createdAt: '2026-10-16T13:59:30.000Z' });
    broker.next(orderAccepted(), orderAccepted());
    const results = await Promise.allSettled([a.service.execute(x, HUMAN), b.service.execute(y, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(broker.writes).toHaveLength(1);
  });
});
