// O22 cycle budget on a real PostgreSQL: two services, two connection pools, two sets of AppendOnlyLog instances on one database
// (two NEXUS processes). The budget is checked inside the reservation step (SELECT ... FOR UPDATE on the log row, then catch-up),
// so a second open passes no gate it could not pass against the current book: whatever the outcome of the first submission, at most
// one open is ever written under the cycle policy, and a restarted process sees the spent budget.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { DEMO_E2E_CYCLE_POLICY, type GateQuote } from '../../src/broker/etoro/execution/execution-gate.js';
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
  const created = await f.service.create(openInput({ amount: '100', ...overrides }), CREATOR);
  expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
  await f.service.approve(created.intentId, HUMAN);
  return created.intentId;
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 cycle budget on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  it('process A writes its open and the broker rejects it; process B passed its gate against the old book and is refused by the budget alone: 1 write', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const holdB = hold();
    const a = await o21Fixture({ stores: await pgStores(db.pool), sharedBroker: broker, policy: DEMO_E2E_CYCLE_POLICY });
    const b = await o21Fixture({ stores: await pgStores(db.extraPool()), sharedBroker: broker, policy: DEMO_E2E_CYCLE_POLICY, quoteSource: holdB.source });
    const x = await approved(a, {});
    const y = await approved(b, { instrumentId: MSFT.instrumentId, etoroInstrumentId: ETORO_MSFT_ID, strategyRunId: 'run-o22-b', createdAt: '2026-10-16T13:59:30.000Z' });

    holdB.arm();
    const late = b.service.execute(y, HUMAN).catch((e: unknown) => e);
    await holdB.reached;
    broker.next({ status: 403 });
    expect((await a.service.execute(x, HUMAN)).state).toBe('REJECTED');
    holdB.release();
    const refused = await late;
    expect(refused).toBeInstanceOf(DemoExecutionError);
    expect((refused as DemoExecutionError).code).toBe('GATE_REFUSED');
    expect((refused as DemoExecutionError).reasons).toEqual(['CYCLE_OPEN_BUDGET_EXHAUSTED']);
    expect(broker.writes).toHaveLength(1);
    const rows = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'etoro-demo-execution-intents' AND payload->>'state' = 'SUBMITTING'");
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('two processes execute two approved opens at once: exactly one write', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const a = await o21Fixture({ stores: await pgStores(db.pool), sharedBroker: broker, policy: DEMO_E2E_CYCLE_POLICY });
    const b = await o21Fixture({ stores: await pgStores(db.extraPool()), sharedBroker: broker, policy: DEMO_E2E_CYCLE_POLICY });
    const x = await approved(a, {});
    const y = await approved(b, { instrumentId: MSFT.instrumentId, etoroInstrumentId: ETORO_MSFT_ID, strategyRunId: 'run-o22-b', createdAt: '2026-10-16T13:59:30.000Z' });
    broker.next(orderAccepted(), orderAccepted());
    const results = await Promise.allSettled([a.service.execute(x, HUMAN), b.service.execute(y, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(broker.writes).toHaveLength(1);
  });

  it('a restarted process on the same database sees the spent budget after a timeout: no second open', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const a = await o21Fixture({ stores: await pgStores(db.pool), sharedBroker: broker, policy: DEMO_E2E_CYCLE_POLICY });
    const x = await approved(a, {});
    broker.next({ throws: 'timeout' });
    expect((await a.service.execute(x, HUMAN)).state).toBe('AMBIGUOUS');
    const restarted = await o21Fixture({ stores: await pgStores(db.extraPool()), sharedBroker: broker, policy: DEMO_E2E_CYCLE_POLICY });
    const again = await restarted.service.create(openInput({ amount: '100', instrumentId: MSFT.instrumentId, etoroInstrumentId: ETORO_MSFT_ID, strategyRunId: 'run-o22-restart' }), CREATOR);
    expect(again.state).toBe('REJECTED');
    expect(again.gateReasons).toEqual(expect.arrayContaining(['AMBIGUOUS_INTENT_UNRESOLVED', 'CYCLE_OPEN_BUDGET_EXHAUSTED']));
    expect(await restarted.service.cycleBudget()).toMatchObject({ openSubmissions: 1, closeSubmissions: 0 });
    expect(broker.writes).toHaveLength(1);
  });
});
