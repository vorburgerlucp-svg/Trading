// O22 Plan C review of PR #35 (R1-R4) on a real PostgreSQL with two processes and a scripted broker: a cycle close against a write.
// The safety statement: a cycle is reported CLOSED only when no broker write of it can still be sent, no answer is outstanding and no
// result is ambiguous; and once a close has begun (CLOSING), no new reservation of the cycle is possible. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import type { AppendOnlyStore } from '../../src/persistence/append-only-log.js';
import type { AttemptRecord, IntentEvent } from '../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import { CYCLE_ACTIVATION_STATEMENT, policyHashOf, type DemoCycleRecord } from '../../src/broker/etoro/execution/demo-cycles.js';
import { DEFAULT_DEMO_EXECUTION_POLICY, type DemoExecutionPolicy } from '../../src/broker/etoro/execution/execution-gate.js';
import { CREATOR, ETORO_AAPL_ID, HUMAN, ScriptedBroker, approvedOpen, closeInput, filledOpen, o21Fixture, openInput, orderAccepted, type Fixture, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { FaultStore, InjectedCrash, ReadHoldStore } from '../broker/etoro/o22-fault-store.js';
import { AppendOnlyLog, AppendOnlyLogError, GENESIS_HASH, hashRecord } from '../../src/persistence/append-only-log.js';
import { encodeJson } from '../../src/persistence/json-codec.js';

const closeSubmitted = { status: 200, body: { orderForClose: { positionID: 2150941015, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 }, token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };
const closeFilled = { status: 200, body: { orderID: 13904638, CID: 1, statusID: 3, orderType: 19, instrumentID: ETORO_AAPL_ID, positions: [{ positionID: 2150941015 }] } };

/** An approved close of a FILLED open of the active cycle (the open spent the cycle's open budget). */
async function approvedClose(f: Fixture): Promise<string> {
  const open = await filledOpen(f);
  const close = await f.service.create(closeInput(open), CREATOR);
  expect(close.state, close.gateReasons.join(',')).toBe('RISK_APPROVED');
  await f.service.approve(close.intentId, HUMAN);
  return close.intentId;
}
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: the write path needs the compile-time lock open for this module.
vi.mock('../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

const HOUR = 60 * 60 * 1000;
const policyOf = (version: string): DemoExecutionPolicy =>
  Object.freeze({ ...DEFAULT_DEMO_EXECUTION_POLICY, version: ('etoro-demo-cycle-policy:' + version) as DemoExecutionPolicy['version'], maxOpenSubmissions: 1, maxCloseSubmissions: 1 });
const authorize = (version: string) => ({ policyHash: policyHashOf(policyOf(version)), statement: CYCLE_ACTIVATION_STATEMENT });

async function stores(pool: PgPool): Promise<{ execution: O21Stores; cycles: PostgresAppendOnlyStore<DemoCycleRecord> }> {
  return {
    execution: {
      intents: await PostgresAppendOnlyStore.open<IntentEvent>(pool, 'etoro-demo-execution-intents'),
      attempts: await PostgresAppendOnlyStore.open<AttemptRecord>(pool, 'etoro-demo-execution-attempts'),
      confirmations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-broker-confirmations'),
      reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-reconciliations'),
    },
    cycles: await PostgresAppendOnlyStore.open<DemoCycleRecord>(pool, 'etoro-demo-cycles'),
  };
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 Plan C review R1-R4: cycle close against a write, two processes on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  async function setup(wrapCyclesA?: (s: AppendOnlyStore<DemoCycleRecord>) => AppendOnlyStore<DemoCycleRecord>, wrapIntentsA?: (s: AppendOnlyStore<IntentEvent>) => AppendOnlyStore<IntentEvent>): Promise<{ a: Fixture; b: Fixture; broker: ScriptedBroker; db: TestDatabase }> {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool);
    const sb = await stores(db.extraPool());
    const a = await o21Fixture({ stores: { ...sa.execution, ...(wrapIntentsA ? { intents: wrapIntentsA(sa.execution.intents) } : {}) }, cycles: wrapCyclesA ? wrapCyclesA(sa.cycles) : sa.cycles, sharedBroker: broker });
    const b = await o21Fixture({ stores: sb.execution, cycles: sb.cycles, sharedBroker: broker });
    await a.service.defineCycle({ cycleId: 'cycle-1', policy: policyOf('one'), maxActiveMs: HOUR }, HUMAN);
    await a.service.activateCycle('cycle-1', authorize('one'), HUMAN);
    return { a, b, broker, db };
  }

  it('R1/R3: A passed its last cycle check and is about to send; B closes: the cycle is NOT reported closed until A\'s write is settled', async () => {
    let hold: ReadHoldStore<DemoCycleRecord> | null = null;
    const { a, b, broker } = await setup((s) => (hold = new ReadHoldStore(s)));
    const id = await approvedOpen(a);
    // execute reads the cycle log three times: the catch-up at its start, before the reservation, and after it (the last check).
    hold!.holdAfterRead(3);
    broker.next(orderAccepted());
    const execution = a.service.execute(id, HUMAN);
    execution.catch(() => undefined);
    await hold!.reached;
    // A has reserved (SUBMITTING) and read the cycle as active for the last time; nothing is sent yet.
    expect((await b.service.get(id)).state).toBe('SUBMITTING');
    expect(broker.requests).toHaveLength(0);
    const first = await b.service.closeCycle('cycle-1', HUMAN);
    // A write may still be sent: the close may not be final.
    expect(first.status).not.toBe('closed');
    hold!.release();
    await execution;
    expect(broker.writes).toHaveLength(1);
    expect((await b.service.get(id)).state).toBe('SUBMITTED');
    // Nothing is in flight any more, but the order is at the broker without a final status (review R5): still not closed.
    expect(await b.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', settlement: { writesInFlight: 0, ordersUnresolved: 1, positionsOpen: 0 } });
  }, 60_000);

  it('R1/R3 for a CLOSE intent: A passed its last cycle check and is about to send the close; B closes the cycle: CLOSING until A is settled', async () => {
    let hold: ReadHoldStore<DemoCycleRecord> | null = null;
    const { a, b, broker } = await setup((s) => (hold = new ReadHoldStore(s)));
    const close = await approvedClose(a);
    hold!.holdAfterRead(3);
    broker.next(closeSubmitted);
    const execution = a.service.execute(close, HUMAN);
    execution.catch(() => undefined);
    await hold!.reached;
    expect((await b.service.get(close)).state).toBe('SUBMITTING');
    const first = await b.service.closeCycle('cycle-1', HUMAN);
    expect(first).toMatchObject({ status: 'closing', inFlight: 1 });
    hold!.release();
    await execution;
    expect(broker.writes.map((w) => w.method)).toEqual(['POST', 'POST']); // the open, and the close that passed before the close began
    // The close order is submitted, not yet confirmed, and the open's position is therefore still open (review R5): still CLOSING.
    // Its status read (simulated: filled) settles both.
    expect(await b.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', settlement: { writesInFlight: 0, ordersUnresolved: 1, positionsOpen: 1 } });
    broker.next(closeFilled);
    expect((await b.service.refresh(close)).state).toBe('FILLED');
    expect((await b.service.closeCycle('cycle-1', HUMAN)).status).toBe('closed');
  }, 60_000);

  it.each(['open', 'close'] as const)('R4 close wins (%s intent): B closes the cycle before A reserves: nothing reserved, nothing sent, no budget spent', async (kind) => {
    const { a, b, broker } = await setup();
    const id = kind === 'open' ? await approvedOpen(a) : await approvedClose(a);
    const writes = broker.writes.length;
    const budget = await b.service.cycleBudget('cycle-1');
    // Closing begins (CLOSING). With the close intent the filled open's position is still open, so the cycle is not settled (R5).
    expect((await b.service.closeCycle('cycle-1', HUMAN)).status).toBe(kind === 'open' ? 'closed' : 'closing');
    await expect(a.service.execute(id, HUMAN)).rejects.toMatchObject({ code: 'GATE_REFUSED' });
    expect((await b.service.get(id)).history.some((h) => h.state === 'SUBMITTING')).toBe(false);
    expect(broker.writes).toHaveLength(writes);
    expect(await b.service.cycleBudget('cycle-1')).toEqual(budget);
  }, 60_000);

  it('R4 parallel: both processes close at once: one CLOSING and one CLOSED record, both callers see it closed', async () => {
    const { a, b } = await setup();
    const results = await Promise.all([a.service.closeCycle('cycle-1', HUMAN), b.service.closeCycle('cycle-1', HUMAN)]);
    expect(results.map((r) => r.status)).toEqual(['closed', 'closed']);
    await a.cycles!.sync();
    expect(a.cycles!.all().map((r) => r.payload.kind)).toEqual(['defined', 'activated', 'closing', 'closed']);
  }, 60_000);

  it('R3/R4 crash: A crashes right after its reservation (SUBMITTING) committed: the cycle stays CLOSING (fail closed), also after a restart and the timeout', async () => {
    let fault: FaultStore<IntentEvent> | null = null;
    const { a, b, broker, db } = await setup(undefined, (s) => (fault = new FaultStore(s)));
    const id = await approvedOpen(a);
    fault!.crashAt((e) => e.state === 'SUBMITTING', 'after');
    await expect(a.service.execute(id, HUMAN)).rejects.toBeInstanceOf(InjectedCrash);
    expect(broker.requests).toHaveLength(0);
    // Whether A's write was sent cannot be known: the cycle is not reported closed.
    expect(await b.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', inFlight: 1 });
    // A restarted process: the cycle takes no new intent, and after the timeout the reservation becomes AMBIGUOUS, still in flight.
    const sc = await stores(db.extraPool());
    const restarted = await o21Fixture({ stores: sc.execution, cycles: sc.cycles, sharedBroker: broker });
    restarted.advance(31_000);
    // The refresh turns the stale reservation AMBIGUOUS and reads the order by its reference (simulated broker: not found).
    broker.next({ status: 404, body: {} });
    await restarted.service.refresh(id).catch(() => undefined);
    expect((await restarted.service.get(id)).state).toBe('AMBIGUOUS');
    expect(await restarted.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', inFlight: 1 });
    await expect(restarted.service.create(openInput({ strategyRunId: 'run-after-crash' }), CREATOR)).rejects.toMatchObject({ reasons: ['CYCLE_NOT_ACTIVE'] });
    expect(broker.writes).toHaveLength(0);
  }, 60_000);

  it('R3 ambiguous: A\'s write times out (AMBIGUOUS): the cycle stays CLOSING while the result is unclear', async () => {
    const { a, b, broker } = await setup();
    const id = await approvedOpen(a);
    broker.next({ throws: 'timeout' });
    expect((await a.service.execute(id, HUMAN)).state).toBe('AMBIGUOUS');
    expect(await b.service.closeCycle('cycle-1', HUMAN)).toMatchObject({ status: 'closing', inFlight: 1 });
    // A closing cycle is not over: no other cycle can be activated meanwhile.
    await b.service.defineCycle({ cycleId: 'cycle-2', policy: policyOf('two'), maxActiveMs: HOUR }, HUMAN);
    await expect(b.service.activateCycle('cycle-2', authorize('two'), HUMAN)).rejects.toMatchObject({ reasons: expect.arrayContaining(['ANOTHER_CYCLE_ACTIVE']) });
  }, 60_000);
});

describe('R2: the guarded write of the store', () => {
  it('in memory: refused when the guard log is not in the same storage kind; the guard\'s records are read in the critical section', async () => {
    const guard = await AppendOnlyLog.inMemory<{ n: number }>('guard');
    const log = await AppendOnlyLog.inMemory<{ n: number }>('log');
    await guard.append('g1', { n: 1 });
    let seen: number[] = [];
    await log.append<{ n: number }>('l1', { n: 1 }, { guard: { log: guard, check: (records) => { seen = records.map((r) => r.payload.n); } } });
    expect(seen).toEqual([1]);
    await expect(log.append<{ n: number }>('l2', { n: 2 }, { guard: { log: guard, check: () => { throw new Error('refused'); } } })).rejects.toThrow('refused');
    expect(log.size).toBe(1);
    const foreign = { loadAll: async () => [], loadAfter: async () => [], writeExclusive: () => Promise.reject(new Error('x')) };
    const other = await AppendOnlyLog.open<{ n: number }>('other', foreign);
    await expect(log.append<{ n: number }>('l3', { n: 3 }, { guard: { log: other, check: () => undefined } })).rejects.toBeInstanceOf(AppendOnlyLogError);
  });

  it.skipIf(!pgAvailable)('PostgreSQL: a guarded write WAITS for an open transaction of a guard writer and then sees its record (FOR SHARE)', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const log = await AppendOnlyLog.open<{ n: number }>('intents', await PostgresAppendOnlyStore.open(db.pool, 'guard-share-a'));
    const guard = await AppendOnlyLog.open<{ n: number }>('cycles', await PostgresAppendOnlyStore.open(db.pool, 'guard-share-b'));
    // A guard writer in the middle of its transaction: the guard log's head row FOR UPDATE, its record inserted, not yet committed.
    const writer = await db.extraPool().connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT head_sequence FROM append_only_logs WHERE log_name = 'guard-share-b' FOR UPDATE");
      const unsigned = { sequence: 1, id: 'closing', recordedAt: new Date('2026-10-16T14:00:00.000Z').toISOString(), payload: { n: 7 }, prevHash: GENESIS_HASH };
      await writer.query('INSERT INTO append_only_records (log_name, sequence, record_id, recorded_at, payload, prev_hash, hash) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
        ['guard-share-b', 1, unsigned.id, unsigned.recordedAt, JSON.stringify(encodeJson(unsigned.payload)), unsigned.prevHash, hashRecord(unsigned)]);
      let seen: number[] | null = null;
      let done = false;
      const append = log.append<{ n: number }>('x', { n: 1 }, { guard: { log: guard, check: (records) => { seen = records.map((r) => r.payload.n); } } }).then(() => { done = true; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      // It waits on the guard's row (FOR SHARE against FOR UPDATE): neither decided nor written while the writer is uncommitted.
      expect(done).toBe(false);
      expect(seen).toBeNull();
      await writer.query('COMMIT');
      await append;
      expect(seen).toEqual([7]);
    } finally {
      writer.release();
    }
  }, 60_000);

  it.skipIf(!pgAvailable)('PostgreSQL: a guard record that does not match its hash is refused (integrity), nothing is written', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const log = await AppendOnlyLog.open<{ n: number }>('intents', await PostgresAppendOnlyStore.open(db.pool, 'guard-int-a'));
    const guard = await AppendOnlyLog.open<{ n: number }>('cycles', await PostgresAppendOnlyStore.open(db.pool, 'guard-int-b'));
    // TEST ONLY: a record written past the log's own checks, with a hash that does not belong to it.
    await db.pool.query('INSERT INTO append_only_records (log_name, sequence, record_id, recorded_at, payload, prev_hash, hash) VALUES ($1, 1, $2, now(), $3::jsonb, $4, $5)',
      ['guard-int-b', 'forged', JSON.stringify(encodeJson({ n: 1 })), GENESIS_HASH, 'f'.repeat(64)]);
    await expect(log.append<{ n: number }>('x', { n: 1 }, { guard: { log: guard, check: () => undefined } })).rejects.toMatchObject({ code: 'integrity' });
    expect(log.size).toBe(0);
  }, 60_000);

  it.skipIf(!pgAvailable)('PostgreSQL: a guard log of another storage (another pool) is refused, nothing is written', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const intents = await AppendOnlyLog.open<{ n: number }>('a', await PostgresAppendOnlyStore.open(db.pool, 'guard-test-a'));
    const guard = await AppendOnlyLog.open<{ n: number }>('b', await PostgresAppendOnlyStore.open(db.extraPool(), 'guard-test-b'));
    await expect(intents.append<{ n: number }>('x', { n: 1 }, { guard: { log: guard, check: () => undefined } })).rejects.toBeInstanceOf(AppendOnlyLogError);
    expect(intents.size).toBe(0);
  }, 60_000);
});
