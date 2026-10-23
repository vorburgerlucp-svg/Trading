// O22 D4 on a real PostgreSQL with two processes (own pool, own logs): the broker evidence of a close is checked by each process in
// its gate and again in the reservation step (SELECT ... FOR UPDATE on the intent log, then catch-up). At most one close write;
// a refusal sends nothing and spends no close budget.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { CREATOR, DEFAULT_BROKER_POSITION, ETORO_AAPL_ID, HUMAN, ScriptedBroker, closeInput, filledOpen, o21Fixture, type Fixture, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { DemoExecutionError } from '../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: the write path needs the compile-time lock open for this module.
vi.mock('../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

const POSITION = DEFAULT_BROKER_POSITION.positionId;
const closeSubmitted = { status: 200, body: { orderForClose: { positionID: POSITION, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 }, token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };

async function pgStores(pool: PgPool): Promise<O21Stores> {
  return {
    intents: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-intents'),
    attempts: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-attempts'),
    confirmations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-broker-confirmations'),
    reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-reconciliations'),
  };
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 D4 close evidence with two processes on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  async function twoProcesses(): Promise<{ a: Fixture; b: Fixture; broker: ScriptedBroker; close: string }> {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const a = await o21Fixture({ stores: await pgStores(db.pool), sharedBroker: broker });
    const b = await o21Fixture({ stores: await pgStores(db.extraPool()), sharedBroker: broker });
    const open = await filledOpen(a, POSITION);
    const created = await a.service.create(closeInput(open), CREATOR);
    expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
    await a.service.approve(created.intentId, HUMAN);
    return { a, b, broker, close: created.intentId };
  }

  it('both processes execute the same close at once with fresh evidence: exactly one close write', async () => {
    const { a, b, broker, close } = await twoProcesses();
    broker.next(closeSubmitted, closeSubmitted);
    const results = await Promise.allSettled([a.service.execute(close, HUMAN), b.service.execute(close, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(DemoExecutionError);
    expect(broker.writes.map((w) => w.method)).toEqual(['POST', 'POST']); // the open and one close
    expect(await b.service.cycleBudget()).toMatchObject({ closeSubmissions: 1 });
  }, 60_000);

  it('the position was closed by hand (both snapshots without it): both processes refuse, nothing sent, no close budget', async () => {
    const { a, b, broker, close } = await twoProcesses();
    a.setSnapshot({ positions: [] });
    b.setSnapshot({ positions: [] });
    const results = await Promise.allSettled([a.service.execute(close, HUMAN), b.service.execute(close, HUMAN)]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'GATE_REFUSED', reasons: ['CLOSE_POSITION_NOT_OPEN_AT_BROKER'] });
    }
    expect(broker.writes).toHaveLength(1);
    expect(await a.service.cycleBudget()).toMatchObject({ closeSubmissions: 0 });
    expect((await b.service.get(close)).state).toBe('APPROVED');
  }, 60_000);

  it('one process sees a stale snapshot, the other a fresh one: the stale one refuses, at most one close write', async () => {
    const { a, b, broker, close } = await twoProcesses();
    a.setSnapshot({ observedAt: '2026-10-16T13:00:00.000Z', positions: [DEFAULT_BROKER_POSITION] });
    broker.next(closeSubmitted);
    const results = await Promise.allSettled([a.service.execute(close, HUMAN), b.service.execute(close, HUMAN)]);
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'GATE_REFUSED' });
    expect(((results[0] as PromiseRejectedResult).reason as DemoExecutionError).reasons).toContain('CLOSE_POSITION_EVIDENCE_STALE');
    expect(results[1]!.status).toBe('fulfilled');
    expect(broker.writes).toHaveLength(2);
    expect(await a.service.cycleBudget()).toMatchObject({ closeSubmissions: 1 });
  }, 60_000);
});
