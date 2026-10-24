// O22 Plan B review R1: forced cross-log races on a real PostgreSQL between an operator attestation (attestation log) and a NEXUS close
// of the same position (intent log), two processes, with controlled holds (no network: scripted broker, fixture portfolio).
//
// The invariant: an attestation may never end the liveness of a position while a NEXUS close of it may have been sent. Either the
// close is not sent (it sees the attestation after its reservation), or the attestation has no effect (it sees the possibly sent
// close). Both orders are forced here. The race needs a flip of the stored snapshots (one without the position for the attestation,
// a newer one with it for the close's evidence), which is exactly the inconsistent broker data the checks must survive.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import type { AttemptRecord } from '../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import type { ExternalClosureRecord } from '../../src/broker/etoro/execution/external-closure.js';
import { CREATOR, ETORO_AAPL_ID, HUMAN, ScriptedBroker, closeInput, openInput, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { HoldStore } from '../broker/etoro/o22-fault-store.js';
import { POSITION, closureProcess, filledThenClosedByHand, type ClosureProcess, type EtoroStores } from '../broker/etoro/o22-external-closure-scenario.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: the write path needs the compile-time lock open for this module.
vi.mock('../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

const closeSubmitted = { status: 200, body: { orderForClose: { positionID: POSITION, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 }, token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };
/** States in which a close may have been sent to the broker (or was filled). */
const POSSIBLY_SENT = new Set(['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'AMBIGUOUS', 'RECONCILED']);

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

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 Plan B R1: attestation vs NEXUS close, forced races on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  /**
   * A: opened (FILLED), stored S1 (position) and S2 (no position), and starts an attestation that is held right before its write
   * (it has decided: no NEXUS close exists). B: a second process whose close attempts can be held after a record committed.
   */
  async function raceSetup(): Promise<{ a: ClosureProcess; b: ClosureProcess; open: string; attestation: Promise<ExternalClosureRecord>; holdA: HoldStore<ExternalClosureRecord>; holdB: HoldStore<AttemptRecord>; broker: ScriptedBroker }> {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool);
    const holdA = new HoldStore(sa.closures);
    const a = await closureProcess({ stores: sa.execution, etoroStores: sa.etoro, closures: holdA, broker });
    const { open, closedSnapshot } = await filledThenClosedByHand(a);
    const sb = await stores(db.extraPool());
    const holdB = new HoldStore(sb.execution.attempts);
    const b = await closureProcess({ stores: { ...sb.execution, attempts: holdB }, etoroStores: sb.etoro, closures: sb.closures, broker });
    holdA.hold('before');
    const attestation = a.attest(open, closedSnapshot);
    attestation.catch(() => undefined);
    await holdA.reached;
    // The flip: B stores a newer snapshot that shows the position again, then creates and approves a close of it on that evidence.
    b.f.clock.now = new Date(a.f.clock.now.getTime() + 10_000);
    await b.sync('with_position');
    const close = await b.f.service.create({ ...closeInput(open), createdAt: b.f.clock.now.toISOString(), expiresAt: new Date(b.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(close.state, close.gateReasons.join(',')).toBe('RISK_APPROVED');
    await b.f.service.approve(close.intentId, HUMAN);
    return { a, b, open, attestation, holdA, holdB, broker };
  }

  /** The invariant, read by a fresh look of process B at the database. */
  async function assertInvariant(b: ClosureProcess, open: string): Promise<{ closeState: string; positionLive: boolean }> {
    const views = await b.f.service.list();
    const close = views.find((v) => v.intent.action === 'close')!;
    const probe = await b.f.service.create({ ...openInput({ strategyRunId: 'run-r1-probe-' + close.state }), createdAt: b.f.clock.now.toISOString(), expiresAt: new Date(b.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    const positionLive = probe.gateReasons.includes('INSTRUMENT_HAS_LIVE_POSITION_OR_ORDER');
    if (POSSIBLY_SENT.has(close.state)) expect(positionLive, 'a close may have been sent: the position must still count as live').toBe(true);
    void open;
    return { closeState: close.state, positionLive };
  }

  it('the attestation commits between the close\'s reservation (SUBMITTING) and its write: the close is not sent', async () => {
    const { a, b, open, attestation, holdA, holdB, broker } = await raceSetup();
    // B reserves (SUBMITTING) and records the started attempt, then is held before the write.
    holdB.hold('after', (p) => p.operation === 'demo.position.close' && p.phase === 'started');
    broker.next(closeSubmitted);
    const close = (await b.f.service.list()).find((v) => v.intent.action === 'close')!.intentId;
    const execution = b.f.service.execute(close, HUMAN);
    execution.catch(() => undefined);
    await holdB.reached;
    // A's attestation commits now (it decided before the close existed).
    holdA.release();
    await attestation;
    holdB.release();
    await execution.catch(() => undefined);
    const { closeState } = await assertInvariant(b, open);
    expect(closeState).toBe('REJECTED');
    expect(broker.writes.map((w) => w.method)).toEqual(['POST']); // the open only: the close was not sent
    expect(await b.f.service.cycleBudget()).toMatchObject({ closeSubmissions: 1 }); // SUBMITTING was recorded: spent, never resent
    // The close was rejected without being sent: the attestation takes effect; the refusal is recorded as not sent.
    expect((await b.f.service.get(open)).externalClosure).toMatchObject({ effective: true });
    const attempts = b.f.attempts.all().map((r) => r.payload).filter((x) => x.operation === 'demo.position.close');
    expect(attempts.map((x) => [x.phase, x.outcome ?? null, x.code ?? null])).toEqual([['started', null, null], ['finished', 'not_sent', 'EXTERNAL_CLOSURE_ATTESTED']]);
    void a;
  }, 60_000);

  it('the close is sent before the attestation commits: the attestation is recorded but has no effect', async () => {
    const { b, open, attestation, holdA, broker } = await raceSetup();
    broker.next(closeSubmitted);
    const close = (await b.f.service.list()).find((v) => v.intent.action === 'close')!.intentId;
    expect((await b.f.service.execute(close, HUMAN)).state).toBe('SUBMITTED');
    holdA.release();
    await attestation;
    const { closeState, positionLive } = await assertInvariant(b, open);
    expect(closeState).toBe('SUBMITTED');
    expect(positionLive).toBe(true);
    expect((await b.f.service.get(open)).externalClosure).toMatchObject({ effective: false });
  }, 60_000);

  it('a newer snapshot that shows the position is stored while the attestation is held: recorded, then flagged as contradicted, and every open is refused', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const sa = await stores(db.pool);
    const holdA = new HoldStore(sa.closures);
    const a = await closureProcess({ stores: sa.execution, etoroStores: sa.etoro, closures: holdA, broker });
    const { open, closedSnapshot } = await filledThenClosedByHand(a);
    const sb = await stores(db.extraPool());
    const b = await closureProcess({ stores: sb.execution, etoroStores: sb.etoro, closures: sb.closures, broker });
    holdA.hold('before');
    const attestation = a.attest(open, closedSnapshot);
    await holdA.reached;
    b.f.clock.now = new Date(a.f.clock.now.getTime() + 10_000);
    await b.sync('with_position');
    holdA.release();
    // The attestation decided on the snapshot that was newest then; the snapshot log is not part of its lock (no cross-log
    // transaction). The contradiction is not lost: it is reported, and no open can pass while it stands.
    expect((await attestation).snapshotId).toBe(closedSnapshot);
    const { reconcileDemoCycle } = await import('../../src/broker/etoro/execution/demo-cycle-reconciliation.js');
    const reconciliation = reconcileDemoCycle(await b.f.service.list(), await b.etoro.latestSnapshot());
    expect(reconciliation.items.map((i) => i.kind)).toEqual(['closed_externally_contradicted']);
    expect(reconciliation.verdict).toBe('inconsistent');
    const probe = await b.f.service.create({ ...openInput({ strategyRunId: 'run-r1-snapshot' }), createdAt: b.f.clock.now.toISOString(), expiresAt: new Date(b.f.clock.now.getTime() + 600_000).toISOString() }, CREATOR);
    expect(probe.gateReasons).toContain('EXTERNALLY_CLOSED_POSITION_SHOWN_AT_BROKER');
    expect(broker.writes).toHaveLength(1);
  }, 60_000);
});
