// O22 cancel review on a real PostgreSQL with two processes (own pools, own logs, isolated test database): the access check of a
// cancel holds across processes, and the at-most-once rule of cancel is unchanged (concurrent cancels, a crash after the started
// attempt). No network: scripted broker answers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import type { AttemptRecord } from '../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import { HUMAN, ScriptedBroker, approvedOpen, lookupAnswer, o21Fixture, orderAccepted, testAccess, type Fixture, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { BarrierStore, FaultStore, HoldStore, InjectedCrash, WriteBarrier } from '../broker/etoro/o22-fault-store.js';
import type { AccessVerifier } from '../../src/broker/etoro/etoro-access-fingerprint.js';
import type { AppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: the write path needs the compile-time lock open for this module.
vi.mock('../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

const OTHER_USER_KEY = 'O22-OTHER-ACCOUNT-USER-KEY-MARKER-000000000000000000000000003';
const cancelAccepted = { status: 200, body: { token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };

async function pgStores(pool: PgPool, wrapAttempts?: (s: AppendOnlyStore<AttemptRecord>) => AppendOnlyStore<AttemptRecord>): Promise<O21Stores> {
  const attempts = await PostgresAppendOnlyStore.open<AttemptRecord>(pool, 'etoro-demo-execution-attempts');
  return {
    intents: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-intents'),
    attempts: wrapAttempts ? wrapAttempts(attempts) : attempts,
    confirmations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-broker-confirmations'),
    reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-reconciliations'),
  };
}

const databases: TestDatabase[] = [];
const deletes = (broker: ScriptedBroker) => broker.requests.filter((r) => r.method === 'DELETE').length;

describe.skipIf(!pgAvailable)('O22 cancel review, two processes on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  /** A: sent an MIT open that is now ACCEPTED (pending). B: a second process on the same database. */
  async function setup(options: { accessB?: AccessVerifier; wrapA?: (s: AppendOnlyStore<AttemptRecord>) => AppendOnlyStore<AttemptRecord>; wrapB?: (s: AppendOnlyStore<AttemptRecord>) => AppendOnlyStore<AttemptRecord> } = {}): Promise<{ a: Fixture; b: Fixture; id: string; broker: ScriptedBroker }> {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const a = await o21Fixture({ stores: await pgStores(db.pool, options.wrapA), sharedBroker: broker });
    const id = await approvedOpen(a, { orderType: 'mit', triggerRate: '195' });
    broker.next(orderAccepted(), lookupAnswer(12));
    await a.service.execute(id, HUMAN);
    expect((await a.service.refresh(id)).state).toBe('ACCEPTED');
    const b = await o21Fixture({ stores: await pgStores(db.extraPool(), options.wrapB), sharedBroker: broker, ...(options.accessB ? { access: options.accessB } : {}) });
    return { a, b, id, broker };
  }

  it('both processes cancel at once with the same access: exactly one cancel is sent', async () => {
    const { a, b, id, broker } = await setup();
    broker.next(cancelAccepted, cancelAccepted);
    const results = await Promise.allSettled([a.service.cancel(id, HUMAN), b.service.cancel(id, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(deletes(broker)).toBe(1);
  }, 60_000);

  it('both decided before either wrote (barrier): the check in the attempt log\'s lock lets exactly one through', async () => {
    const barrier = new WriteBarrier(2);
    let armedA = false;
    let armedB = false;
    const { a, b, id, broker } = await setup({
      wrapA: (s) => ({ loadAll: () => s.loadAll(), loadAfter: (n) => s.loadAfter(n), writeExclusive: (k, d) => (armedA ? new BarrierStore(s, barrier) : s).writeExclusive(k, d) }),
      wrapB: (s) => ({ loadAll: () => s.loadAll(), loadAfter: (n) => s.loadAfter(n), writeExclusive: (k, d) => (armedB ? new BarrierStore(s, barrier) : s).writeExclusive(k, d) }),
    });
    armedA = true;
    armedB = true;
    broker.next(cancelAccepted, cancelAccepted);
    const results = await Promise.allSettled([a.service.cancel(id, HUMAN), b.service.cancel(id, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(deletes(broker)).toBe(1);
  }, 60_000);

  it('B is configured with other credentials: B sends nothing, A cancels once', async () => {
    const { a, b, id, broker } = await setup({ accessB: testAccess({ userKey: OTHER_USER_KEY }) });
    broker.next(cancelAccepted);
    const results = await Promise.allSettled([b.service.cancel(id, HUMAN), a.service.cancel(id, HUMAN)]);
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'GATE_REFUSED', reasons: ['CANCEL_TARGET_OPEN_ACCESS_MISMATCH'] });
    expect(results[1]!.status).toBe('fulfilled');
    expect(deletes(broker)).toBe(1);
  }, 60_000);

  it('a second open attempt appears between the check of A and its lock (foreign or tampered data): refused inside the lock, nothing sent', async () => {
    let hold: HoldStore<AttemptRecord> | null = null;
    const { a, b, id, broker } = await setup({ wrapA: (s) => (hold = new HoldStore(s)) });
    hold!.hold('before');
    const cancel = a.service.cancel(id, HUMAN);
    cancel.catch(() => undefined);
    await hold!.reached;
    // TEST ONLY: a record no code path writes (a second started open attempt of the same intent), appended by another process.
    const first = b.attempts.all().map((r) => r.payload).find((x) => x.intentId === id && x.operation === 'demo.order.open' && x.phase === 'started')!;
    await b.attempts.append('eatt_forged:started', { ...first, attemptId: 'eatt_forged', requestId: '00000000-0000-4000-8000-00000000f0f0' });
    hold!.release();
    await expect(cancel).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: ['CANCEL_OPEN_ATTEMPT_NOT_UNIQUE'] });
    expect(deletes(broker)).toBe(0);
  }, 60_000);

  it('A crashes right after its started cancel attempt committed (nothing sent): B refuses another cancel (never resent blindly)', async () => {
    let fault: FaultStore<AttemptRecord> | null = null;
    const { a, b, id, broker } = await setup({ wrapA: (s) => (fault = new FaultStore(s)) });
    fault!.crashAt((p) => p.operation === 'demo.order.cancel' && p.phase === 'started', 'after');
    await expect(a.service.cancel(id, HUMAN)).rejects.toBeInstanceOf(InjectedCrash);
    expect(deletes(broker)).toBe(0);
    await expect(b.service.cancel(id, HUMAN)).rejects.toMatchObject({ code: 'INTENT_STATE_INVALID' });
    expect(deletes(broker)).toBe(0);
  }, 60_000);
});
