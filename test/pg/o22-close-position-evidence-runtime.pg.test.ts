// O22 D4 (R1, R2, R4) on a real PostgreSQL with two processes, with the runtime's own evidence path: each process has its own
// EtoroBrokerService over the PostgreSQL logs the runtime uses (etoro-snapshots, etoro-reconciliations, etoro-sync-events), and its
// demo execution service reads them through storedPositionSource, exactly as compose.ts wires it. The portfolio reads go to a
// fixture transport (no network, no broker); only the snapshots they produce are real stored records.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppendOnlyLog } from '../../src/persistence/append-only-log.js';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { EtoroBrokerService, type EtoroReconciliationRecord, type EtoroSnapshotRecord, type EtoroSyncRecord } from '../../src/broker/etoro/etoro-broker-service.js';
import { EtoroBrokerSyncAdapter } from '../../src/broker/etoro/etoro-sync-adapter.js';
import type { DemoPositionSource } from '../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import { DemoExecutionError } from '../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { storedPositionSource } from '../../src/runtime/demo-execution-sources.js';
import { FixtureEtoroTransport, emptyDemoPortfolio } from '../broker/etoro/o20-fixture.js';
import { documentedPortfolio, documentedPosition } from '../broker/etoro/o21a-documented-fixture.js';
import { CREATOR, ETORO_AAPL_ID, HUMAN, ScriptedBroker, closeInput, filledOpen, o21Fixture, type Fixture, type O21Stores } from '../broker/etoro/o21-fixture.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

// TEST ONLY: the write path needs the compile-time lock open for this module.
vi.mock('../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

const POSITION = 2150941015;
/** The order id filledOpen() gets from the broker; the snapshot names it as the position's opening order. */
const OPEN_ORDER = 13902598;
const closeSubmitted = { status: 200, body: { orderForClose: { positionID: POSITION, instrumentID: ETORO_AAPL_ID, orderID: 13904638, statusID: 1 }, token: '5fe065bc-f6f9-4897-a2ce-c4fccef73ff8' } };
const withPosition = () => documentedPortfolio({ positions: [documentedPosition({ positionID: POSITION, instrumentID: ETORO_AAPL_ID, isBuy: true, orderID: OPEN_ORDER, orderType: 17 })] });

interface Process {
  f: Fixture;
  etoro: EtoroBrokerService;
  portfolio: FixtureEtoroTransport;
  /** Runs (and awaits) `step` right before the next read of the stored evidence; the read itself is the real one. */
  beforeNextRead(step: () => Promise<unknown>): void;
}

async function executionStores(pool: PgPool): Promise<O21Stores> {
  return {
    intents: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-intents'),
    attempts: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-attempts'),
    confirmations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-broker-confirmations'),
    reconciliations: await PostgresAppendOnlyStore.open(pool, 'etoro-demo-execution-reconciliations'),
  };
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 D4 close evidence through the runtime evidence path, two processes on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  async function startProcess(pool: PgPool, broker: ScriptedBroker): Promise<Process> {
    let pending: (() => Promise<unknown>) | null = null;
    let etoro: EtoroBrokerService | null = null;
    const real = (): DemoPositionSource => storedPositionSource(etoro);
    const f = await o21Fixture({
      stores: await executionStores(pool),
      sharedBroker: broker,
      positionSource: {
        latest: async () => {
          const step = pending;
          pending = null;
          if (step) await step();
          return real().latest();
        },
      },
    });
    const clock = () => new Date(f.clock.now.getTime());
    const portfolio = new FixtureEtoroTransport();
    etoro = new EtoroBrokerService({
      adapter: new EtoroBrokerSyncAdapter({ transport: portfolio, clock }),
      ledger: { balances: () => new Map() },
      snapshots: await AppendOnlyLog.open<EtoroSnapshotRecord>('etoro-snapshots', await PostgresAppendOnlyStore.open<EtoroSnapshotRecord>(pool, 'etoro-snapshots'), { clock }),
      reconciliations: await AppendOnlyLog.open<EtoroReconciliationRecord>('etoro-reconciliations', await PostgresAppendOnlyStore.open<EtoroReconciliationRecord>(pool, 'etoro-reconciliations'), { clock }),
      syncs: await AppendOnlyLog.open<EtoroSyncRecord>('etoro-sync-events', await PostgresAppendOnlyStore.open<EtoroSyncRecord>(pool, 'etoro-sync-events'), { clock }),
      clock,
    });
    return { f, etoro, portfolio, beforeNextRead: (step) => { pending = step; } };
  }

  /** A has an approved close of a FILLED open; its own stored snapshot shows the position. B is a second process on the same DB. */
  async function setup(): Promise<{ a: Process; b: Process; broker: ScriptedBroker; close: string }> {
    const db = await createTestDatabase();
    databases.push(db);
    const broker = new ScriptedBroker();
    const a = await startProcess(db.pool, broker);
    const b = await startProcess(db.extraPool(), broker);
    const open = await filledOpen(a.f, POSITION);
    a.portfolio.response = { status: 200, body: withPosition() };
    await a.etoro.sync();
    const created = await a.f.service.create(closeInput(open), CREATOR);
    expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
    await a.f.service.approve(created.intentId, HUMAN);
    return { a, b, broker, close: created.intentId };
  }

  /** B reads the portfolio later and stores a snapshot in which the position is gone (closed by hand). */
  async function bStoresEmptySnapshot(a: Process, b: Process, laterMs: number): Promise<void> {
    b.f.clock.now = new Date(a.f.clock.now.getTime() + laterMs);
    b.portfolio.response = { status: 200, body: emptyDemoPortfolio() };
    await b.etoro.sync();
  }

  it('R1: B stores a newer snapshot without the position; A (whose own copy still shows it) refuses: no close write, no close budget', async () => {
    const { a, b, broker, close } = await setup();
    await bStoresEmptySnapshot(a, b, 60_000);
    a.f.advance(90_000);
    // A's own, not caught-up copy of the snapshot log still has only its snapshot with the position, and it is still fresh.
    expect((await a.etoro.latestSnapshot())?.content.positionCount).toBe(1);
    await expect(a.f.service.execute(close, HUMAN)).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: ['CLOSE_POSITION_NOT_OPEN_AT_BROKER'] });
    expect(broker.writes.map((w) => w.method)).toEqual(['POST']); // the open only
    expect(await a.f.service.cycleBudget()).toMatchObject({ closeSubmissions: 0 });
    expect(await b.f.service.cycleBudget()).toMatchObject({ closeSubmissions: 0 });
    expect((await b.f.service.get(close)).state).toBe('APPROVED');
  }, 60_000);

  it('R2: B stores the snapshot without the position between A\'s gate and A\'s reservation: refused in the reservation step', async () => {
    const { a, b, broker, close } = await setup();
    a.f.advance(30_000);
    // execute reads the evidence twice: in the gate (read 1, still with the position) and right before the reservation (read 2).
    a.beforeNextRead(async () => {
      // B's read is 1 s before A's clock (never in A's future), and after A's own snapshot.
      a.beforeNextRead(() => bStoresEmptySnapshot(a, b, -1_000));
    });
    await expect(a.f.service.execute(close, HUMAN)).rejects.toMatchObject({ code: 'GATE_REFUSED', reasons: ['CLOSE_POSITION_NOT_OPEN_AT_BROKER'] });
    expect(broker.writes).toHaveLength(1);
    expect(await a.f.service.cycleBudget()).toMatchObject({ closeSubmissions: 0 });
    // The refusal is recorded as a gate refusal: nothing was reserved.
    expect(a.f.intents.all().some((r) => r.payload.state === 'SUBMITTING' && r.payload.intentId === close)).toBe(false);
  }, 60_000);

  it('concurrent closes from both processes with the position still open: B sees A\'s snapshot from the store, exactly one close write', async () => {
    const { a, b, broker, close } = await setup();
    b.f.clock.now = new Date(a.f.clock.now.getTime());
    broker.next(closeSubmitted, closeSubmitted);
    const results = await Promise.allSettled([a.f.service.execute(close, HUMAN), b.f.service.execute(close, HUMAN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(DemoExecutionError);
    expect(broker.writes.map((w) => w.method)).toEqual(['POST', 'POST']); // the open and one close
    expect(await b.f.service.cycleBudget()).toMatchObject({ closeSubmissions: 1 });
  }, 60_000);

  it('concurrent closes from both processes after B stored the snapshot without the position: both refuse, nothing sent', async () => {
    const { a, b, broker, close } = await setup();
    await bStoresEmptySnapshot(a, b, 10_000);
    a.f.advance(10_000);
    const results = await Promise.allSettled([a.f.service.execute(close, HUMAN), b.f.service.execute(close, HUMAN)]);
    for (const r of results) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'GATE_REFUSED', reasons: ['CLOSE_POSITION_NOT_OPEN_AT_BROKER'] });
    expect(broker.writes).toHaveLength(1);
    expect(await a.f.service.cycleBudget()).toMatchObject({ closeSubmissions: 0 });
  }, 60_000);
});
