// O22 Plan B on a real PostgreSQL with two processes (own pool, own logs), on an isolated test database: the attestation log and
// every log it reads are the runtime's PostgreSQL logs. One attestation per position whoever writes first; each process sees the
// other's records before it decides; a crash before or after the commit leaves either nothing or the complete record.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { DemoExecutionError } from '../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import type { ExternalClosureRecord } from '../../src/broker/etoro/execution/external-closure.js';
import { CREATOR, HUMAN, ScriptedBroker, closeInput, openInput, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { BarrierStore, FaultStore, InjectedCrash, WriteBarrier } from '../broker/etoro/o22-fault-store.js';
import { POSITION, closureProcess, filledThenClosedByHand, type ClosureProcess, type EtoroStores } from '../broker/etoro/o22-external-closure-scenario.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: filledOpen() exercises the write path, so this module replaces the compile-time lock for this module only.
vi.mock('../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

async function stores(pool: PgPool): Promise<{ execution: O21Stores; etoro: EtoroStores; closures: PostgresAppendOnlyStore<ExternalClosureRecord> }> {
  return {
    execution: {
      intents: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-intents'),
      attempts: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-attempts'),
      confirmations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-broker-confirmations'),
      reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-reconciliations'),
    },
    etoro: {
      snapshots: await PostgresAppendOnlyStore.open(pool, 'etoro-snapshots'),
      reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-reconciliations'),
      syncs: await PostgresAppendOnlyStore.open(pool, 'etoro-sync-events'),
    },
    closures: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-external-closures'),
  };
}

async function reasonsOf(promise: Promise<unknown>): Promise<readonly string[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return error.reasons;
    throw error;
  }
  throw new Error('expected a refusal');
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 Plan B external closure, two processes on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  /** A: the process that opened (filled) and stored both snapshots. B: a second process on the same database, started after. */
  async function setup(options: { faultA?: boolean } = {}): Promise<{ a: ClosureProcess; b: ClosureProcess; open: string; closedSnapshot: string; db: TestDatabase; faults: FaultStore<ExternalClosureRecord> | null }> {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool);
    const faults = options.faultA ? new FaultStore(sa.closures) : null;
    const a = await closureProcess({ stores: sa.execution, etoroStores: sa.etoro, closures: faults ?? sa.closures, broker });
    const { open, closedSnapshot } = await filledThenClosedByHand(a);
    const sb = await stores(db.extraPool());
    const b = await closureProcess({ stores: sb.execution, etoroStores: sb.etoro, closures: sb.closures, broker });
    b.f.clock.now = new Date(a.f.clock.now.getTime());
    return { a, b, open, closedSnapshot, db, faults };
  }

  it('both processes attest at once: exactly one record, the other is refused (ALREADY_ATTESTED)', async () => {
    const { a, b, open, closedSnapshot } = await setup();
    const results = await Promise.allSettled([a.attest(open, closedSnapshot), b.attest(open, closedSnapshot, {}, { kind: 'human', id: 'operator-2' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  }, 60_000);

  it('both processes decided on the same stored state before either wrote (barrier): the check inside the lock refuses the second', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool);
    const sb = await stores(db.extraPool());
    const barrier = new WriteBarrier(2);
    const barrierA = new BarrierStore(sa.closures, barrier);
    const barrierB = new BarrierStore(sb.closures, barrier);
    const a = await closureProcess({ stores: sa.execution, etoroStores: sa.etoro, closures: barrierA, broker });
    const { open, closedSnapshot } = await filledThenClosedByHand(a);
    const b = await closureProcess({ stores: sb.execution, etoroStores: sb.etoro, closures: barrierB, broker });
    b.f.clock.now = new Date(a.f.clock.now.getTime());
    const results = await Promise.allSettled([a.attest(open, closedSnapshot), b.attest(open, closedSnapshot, {}, { kind: 'human', id: 'operator-2' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'EXTERNAL_CLOSURE_REFUSED', reasons: ['ALREADY_ATTESTED'] });
    await a.f.externalClosures!.sync();
    expect(a.f.externalClosures!.size).toBe(1);
  }, 60_000);

  it('B (which never read the portfolio itself) attests from the stored evidence; A then counts the position as no longer live', async () => {
    const { a, b, open, closedSnapshot } = await setup();
    const second = { ...openInput({ strategyRunId: 'run-o22-pg-second' }), createdAt: a.f.clock.now.toISOString(), expiresAt: new Date(a.f.clock.now.getTime() + 600_000).toISOString() };
    expect((await a.f.service.create(second, CREATOR)).gateReasons).toContain('INSTRUMENT_HAS_LIVE_POSITION_OR_ORDER');
    expect((await b.attest(open, closedSnapshot)).positionId).toBe(POSITION);
    const third = await a.f.service.create({ ...second, strategyRunId: 'run-o22-pg-third' }, CREATOR);
    expect(third.gateReasons).not.toContain('INSTRUMENT_HAS_LIVE_POSITION_OR_ORDER');
    expect((await a.f.service.get(open)).externalClosure?.positionId).toBe(POSITION);
    expect(await a.f.service.cycleBudget()).toMatchObject({ openSubmissions: 1, closeSubmissions: 0 });
  }, 60_000);

  it('B approved a NEXUS close of the position: A sees it from the database and refuses (NEXUS_CLOSE_UNRESOLVED)', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool);
    const a = await closureProcess({ stores: sa.execution, etoroStores: sa.etoro, closures: sa.closures, broker });
    const { filledOpen } = await import('../broker/etoro/o21-fixture.js');
    const open = await filledOpen(a.f, POSITION);
    a.f.advance(10_000);
    await a.sync('with_position');
    const sb = await stores(db.extraPool());
    const b = await closureProcess({ stores: sb.execution, etoroStores: sb.etoro, closures: sb.closures, broker });
    b.f.clock.now = new Date(a.f.clock.now.getTime());
    const close = await b.f.service.create({ ...closeInput(open), createdAt: b.f.clock.now.toISOString(), expiresAt: new Date(b.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(close.state, close.gateReasons.join(',')).toBe('RISK_APPROVED');
    await b.f.service.approve(close.intentId, HUMAN);
    a.f.advance(60_000);
    const empty = await a.sync('without_position');
    expect(await reasonsOf(a.attest(open, empty))).toEqual(['NEXUS_CLOSE_UNRESOLVED']);
  }, 60_000);

  it('B stores a newer snapshot that shows the position again: A\'s attestation of the older one is refused', async () => {
    const { a, b, open, closedSnapshot } = await setup();
    b.f.advance(5_000);
    await b.sync('with_position');
    a.f.advance(10_000);
    expect(await reasonsOf(a.attest(open, closedSnapshot))).toEqual(['SNAPSHOT_NOT_NEWEST']);
  }, 60_000);

  it('A crashes right after its record committed: B sees the record and refuses a second one', async () => {
    const { a, b, open, closedSnapshot, faults } = await setup({ faultA: true });
    faults!.crashAt(() => true, 'after');
    await expect(a.attest(open, closedSnapshot)).rejects.toBeInstanceOf(InjectedCrash);
    expect((await b.f.service.get(open)).externalClosure?.positionId).toBe(POSITION);
    expect(await reasonsOf(b.attest(open, closedSnapshot))).toEqual(['ALREADY_ATTESTED']);
  }, 60_000);

  it('A crashes before its record committed: nothing is stored; B can attest', async () => {
    const { a, b, open, closedSnapshot, faults } = await setup({ faultA: true });
    faults!.crashAt(() => true, 'before');
    await expect(a.attest(open, closedSnapshot)).rejects.toBeInstanceOf(InjectedCrash);
    expect((await b.f.service.get(open)).externalClosure).toBeNull();
    expect((await b.attest(open, closedSnapshot)).positionId).toBe(POSITION);
  }, 60_000);
});
