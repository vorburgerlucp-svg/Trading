// O22 crash-safe status check on a real PostgreSQL: every "process" has its own connection pool and its own AppendOnlyLog
// instances on the same database. A crash is injected at each persistence step; a restarted process completes the check from the
// stored evidence (or one read-only GET). Parallel processes are serialized by the log locks (SELECT ... FOR UPDATE on the log
// head, then catch-up) and the preconditions inside them: exactly one original order, one position, the budget unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { ScriptedBroker, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { ORDER, assertSettled, crashAndRestart, heldAnswer, lookup, startProcess, submitted, type Step } from '../broker/etoro/o22-recovery-scenarios.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: the scenarios submit one open, so this module replaces the compile-time lock for this module only.
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

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 crash recovery and parallel processes on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  async function database(): Promise<TestDatabase> {
    const db = await createTestDatabase();
    databases.push(db);
    return db;
  }

  const steps: ['normal' | 'ambiguous', Step][] = [
    ['normal', 'confirm'], ['normal', 'final'],
    ['ambiguous', 'found'], ['ambiguous', 'reconciled'], ['ambiguous', 'confirm'], ['ambiguous', 'final'],
  ];
  for (const [path, step] of steps) {
    for (const point of ['before', 'after'] as const) {
      it(path + ': crash ' + point + ' the ' + step + ' record (the write rolled back or committed), restart on another pool', async () => {
        const db = await database();
        await crashAndRestart(path, step, point, { first: await pgStores(db.pool), restart: async () => pgStores(db.extraPool()) });
      }, 60_000);
    }
  }

  it('two processes refresh the same AMBIGUOUS intent at once: one "found", one RECONCILED, one FILLED, one order', async () => {
    const db = await database();
    const broker = new ScriptedBroker();
    const a = await startProcess(await pgStores(db.pool), broker);
    const b = await startProcess(await pgStores(db.extraPool()), broker);
    const id = await submitted(a, 'ambiguous');
    broker.next(lookup(), lookup(), lookup(), lookup());
    const results = await Promise.allSettled([a.service.refresh(id), b.service.refresh(id)]);
    // At least one completes; the other completes too or stops safely (it never records a second "found" or a second state).
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) if (r.status === 'rejected') expect(['RECONCILIATION_PENDING', 'INTENT_STATE_INVALID']).toContain((r.reason as { code?: string }).code);
    await assertSettled(b, id, 'ambiguous');
    await assertSettled(a, id, 'ambiguous');
  }, 60_000);

  it('two processes find different orders for one AMBIGUOUS intent: the second is RECONCILIATION_CONFLICT, one order is kept', async () => {
    const db = await database();
    const broker = new ScriptedBroker();
    const a = await startProcess(await pgStores(db.pool), broker);
    const b = await startProcess(await pgStores(db.extraPool()), broker);
    const id = await submitted(a, 'ambiguous');
    const held = heldAnswer(lookup({ orderId: ORDER + 1 }));
    broker.next(held.answer);
    const late = b.service.refresh(id).catch((e: unknown) => e);
    await held.reached;
    broker.next(lookup());
    expect((await a.service.refresh(id)).state).toBe('FILLED');
    held.release();
    expect(await late).toMatchObject({ code: 'BROKER_RESPONSE_INVALID', reasons: ['RECONCILIATION_CONFLICT'] });
    await assertSettled(b, id, 'ambiguous');
  }, 60_000);

  it('a stale check of a second process cannot store a contradicting read or state', async () => {
    const db = await database();
    const broker = new ScriptedBroker();
    const a = await startProcess(await pgStores(db.pool), broker);
    const b = await startProcess(await pgStores(db.extraPool()), broker);
    const id = await submitted(a, 'normal');
    const held = heldAnswer(lookup({ statusId: 2, positionIds: [] }));
    broker.next(held.answer);
    const late = b.service.refresh(id).catch((e: unknown) => e);
    await held.reached;
    broker.next(lookup());
    expect((await a.service.refresh(id)).state).toBe('FILLED');
    held.release();
    expect(await late).toMatchObject({ code: 'BROKER_RESPONSE_INVALID', reasons: ['STATUS_CONTRADICTS_EARLIER_READ'] });
    await assertSettled(b, id, 'normal');
  }, 60_000);

  it('a stale but agreeing check of a second process stores no second state: the transition is refused, the state stays FILLED', async () => {
    const db = await database();
    const broker = new ScriptedBroker();
    const a = await startProcess(await pgStores(db.pool), broker);
    const b = await startProcess(await pgStores(db.extraPool()), broker);
    const id = await submitted(a, 'normal');
    const held = heldAnswer(lookup());
    broker.next(held.answer);
    const late = b.service.refresh(id).catch((e: unknown) => e);
    await held.reached;
    broker.next(lookup());
    expect((await a.service.refresh(id)).state).toBe('FILLED');
    held.release();
    expect(await late).toMatchObject({ code: 'INTENT_STATE_INVALID' });
    await assertSettled(b, id, 'normal');
    expect(b.intents.all().filter((r) => r.payload.intentId === id && r.payload.state === 'FILLED')).toHaveLength(1);
  }, 60_000);

  it('two processes recover the same crashed check at once: each step is recorded once', async () => {
    const db = await database();
    const broker = new ScriptedBroker();
    const { withFaults, InjectedCrash } = await import('../broker/etoro/o22-fault-store.js');
    const faults = withFaults(await pgStores(db.pool));
    const first = await startProcess(faults.stores, broker);
    const id = await submitted(first, 'ambiguous');
    faults.confirmations.crashAt((c) => c.kind === 'order_status', 'after');
    broker.next(lookup());
    await expect(first.service.refresh(id)).rejects.toBeInstanceOf(InjectedCrash);
    const a = await startProcess(await pgStores(db.extraPool()), broker);
    const b = await startProcess(await pgStores(db.extraPool()), broker);
    const requests = broker.requests.length;
    const views = await Promise.all([a.service.recover(id), b.service.recover(id)]);
    expect(views.map((v) => v.state)).toEqual(['FILLED', 'FILLED']);
    expect(broker.requests.length).toBe(requests);
    await assertSettled(a, id, 'ambiguous');
  }, 60_000);
});
