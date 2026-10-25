// R1 research worker on PostgreSQL: two processes (two pools on one isolated test database), the advisory lock, crash and
// restart, the credit budget across processes, and the read-only status. Scripted provider, no network, no broker.
import { afterEach, describe, expect, it } from 'vitest';
import type { InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { AppendOnlyLog, type LogRecord, type WriteDecision } from '../../src/persistence/append-only-log.js';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { PostgresMarketDataStore } from '../../src/persistence/postgres/postgres-market-data-store.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { instrumentProjector } from '../../src/persistence/postgres/market-data-projectors.js';
import { CreditBudget, ResearchBudgetError } from '../../src/research/research-budget.js';
import { RESEARCH_SOURCE_ID } from '../../src/research/research-catalog.js';
import { PostgresWorkerLock } from '../../src/research/research-lock.js';
import { assertResearchDatabase, openResearchPool, openResearchStores, openResearchStoresReadOnly, ResearchDatabaseError } from '../../src/research/research-postgres.js';
import { recordsOf, researchRunLogName, type ResearchRunRecord } from '../../src/research/research-run-log.js';
import { researchStatus } from '../../src/research/research-status.js';
import { BTC_ENTRY, AAPL_ENTRY, FakeClock, ScriptedTwelveData, catalogOf, harness, type HarnessStores } from '../research/research-fixtures.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

const NOW = '2026-10-07T15:31:30Z';
const TODAY = researchRunLogName(Date.parse(NOW));
const databases: TestDatabase[] = [];

async function pgStores(pool: PgPool): Promise<HarnessStores> {
  const stores = await openResearchStores(pool);
  return { instruments: stores.instruments, marketData: stores.marketData, openRunLog: stores.openRunLog };
}

async function barRows(pool: PgPool, instrumentId: string): Promise<{ rows: number; starts: number }> {
  const r = await pool.query<{ rows: string; starts: string }>('SELECT count(*)::text AS rows, count(DISTINCT start_time)::text AS starts FROM market_bars WHERE instrument_id = $1', [instrumentId]);
  return { rows: Number(r.rows[0]!.rows), starts: Number(r.rows[0]!.starts) };
}

/** A connection URL for the test database (pgInfo connection), for the research pool factory. */
function urlOf(db: TestDatabase): string {
  if (!pgInfo.available) throw new Error('no pg');
  const c = pgInfo.connection;
  return 'postgres://' + encodeURIComponent(c.user) + ':' + encodeURIComponent(c.password ?? '') + '@' + c.host + ':' + c.port + '/' + db.name;
}

describe.skipIf(!pgAvailable)('R1 research worker on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  async function database(): Promise<TestDatabase> {
    const db = await createTestDatabase();
    databases.push(db);
    return db;
  }

  it('two processes start at once: exactly one runs (advisory lock), the other is skipped; only one fetches', async () => {
    const db = await database();
    const transport = new ScriptedTwelveData();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    transport.beforeAnswer = async () => {
      entered();
      await gate;
    };
    const a = harness({ stores: await pgStores(db.pool), lock: new PostgresWorkerLock(db.pool), transport, catalog: catalogOf([BTC_ENTRY]) });
    const pool2 = db.extraPool();
    const b = harness({ stores: await pgStores(pool2), lock: new PostgresWorkerLock(pool2), transport, catalog: catalogOf([BTC_ENTRY]) });
    const runA = a.run();
    await inside; // A holds the lock and is inside its request
    expect(await b.run()).toMatchObject({ kind: 'skipped', reason: 'LOCK_HELD' });
    release();
    expect(await runA).toMatchObject({ kind: 'finished', status: 'completed' });
    expect(transport.calls).toHaveLength(1);
    // After A released the lock, B can run (and finds nothing new).
    expect(await b.run()).toMatchObject({ kind: 'finished', status: 'completed', instruments: [{ outcome: 'up_to_date' }] });
  }, 60_000);

  it('the lock dies with its connection: a terminated worker session frees it for the next worker', async () => {
    const db = await database();
    const pool2 = db.extraPool();
    const held = await new PostgresWorkerLock(db.pool).tryAcquire();
    expect(held).not.toBeNull();
    expect(await new PostgresWorkerLock(pool2).tryAcquire()).toBeNull();
    const admin = await db.privilegedClient();
    try {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND pid <> pg_backend_pid()", [0x4e585253, 1]);
    } finally {
      await admin.end();
    }
    await expect(held!.assertHeld()).rejects.toThrow(/lock/);
    let next = null;
    for (let i = 0; i < 50 && next === null; i++) next = await new PostgresWorkerLock(pool2).tryAcquire();
    expect(next).not.toBeNull();
    await next!.release();
    await held!.release(); // releasing a lost lock does not throw
  }, 60_000);

  it('repeated runs are idempotent in the database: no duplicate bar rows, no duplicate protocol records', async () => {
    const db = await database();
    const h = harness({ stores: await pgStores(db.pool), lock: new PostgresWorkerLock(db.pool), catalog: catalogOf([AAPL_ENTRY, BTC_ENTRY]), clock: new FakeClock(NOW) });
    await h.run();
    const first = await barRows(db.pool, 'rsx_xnas_aapl');
    await h.run();
    await h.run();
    expect(await barRows(db.pool, 'rsx_xnas_aapl')).toEqual(first);
    expect(first).toEqual({ rows: 7, starts: 7 });
    const ids = await db.pool.query<{ n: string; d: string }>('SELECT count(*)::text AS n, count(DISTINCT record_id)::text AS d FROM append_only_records WHERE log_name = $1', [TODAY]);
    expect(ids.rows[0]!.n).toBe(ids.rows[0]!.d);
  }, 60_000);

  it('a worker that crashes after storing bars: the restarted worker records it as abandoned and does not duplicate data', async () => {
    const db = await database();
    const real = await PostgresAppendOnlyStore.open<ResearchRunRecord>(db.pool, TODAY);
    let writes = 0;
    const crashing = Object.create(real) as PostgresAppendOnlyStore<ResearchRunRecord>;
    crashing.writeExclusive = (<R>(known: number, decide: (newer: readonly LogRecord<ResearchRunRecord>[]) => WriteDecision<ResearchRunRecord, R>): Promise<R> => {
      if (++writes > 2) return Promise.reject(new Error('simulated crash'));
      return real.writeExclusive(known, decide);
    }) as typeof real.writeExclusive;
    const base = await pgStores(db.pool);
    const h1 = harness({ stores: { ...base, openRunLog: async (name) => (name === TODAY ? AppendOnlyLog.open(name, crashing) : base.openRunLog(name)) }, lock: new PostgresWorkerLock(db.pool), catalog: catalogOf([BTC_ENTRY]) });
    await expect(h1.run()).rejects.toThrow('simulated crash');
    const stored = await barRows(db.pool, 'rsx_crypto_btcusd');
    expect(stored.rows).toBe(7);
    const pool2 = db.extraPool();
    const h2 = harness({ stores: await pgStores(pool2), lock: new PostgresWorkerLock(pool2), catalog: catalogOf([BTC_ENTRY]) });
    const out = await h2.run();
    expect(out).toMatchObject({ kind: 'finished', status: 'completed', abandonedRuns: [expect.stringMatching(/-run-1$/)], instruments: [{ outcome: 'up_to_date' }] });
    expect(await barRows(db.pool, 'rsx_crypto_btcusd')).toEqual(stored);
  }, 60_000);

  it('the credit budget holds across processes, even without the worker lock (checked inside the log critical section)', async () => {
    const db = await database();
    const clock = new FakeClock(NOW);
    const budgetIn = async (pool: PgPool, runId: string) => {
      const log = await AppendOnlyLog.open<ResearchRunRecord>(TODAY, await PostgresAppendOnlyStore.open<ResearchRunRecord>(pool, TODAY));
      return new CreditBudget({ budget: { dailyCredits: 1, minuteCredits: 8 }, runId, log, records: () => log.all().map((r) => r.payload), clock: clock.now, sleep: clock.sleep, deadlineMs: clock.ms + 60_000 });
    };
    const [x, y] = await Promise.all([budgetIn(db.pool, 'run-x'), budgetIn(db.extraPool(), 'run-y')]);
    const results = await Promise.allSettled([x.reserve(1, '/time_series'), y.reserve(1, '/time_series')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ResearchBudgetError);
    const n = await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM append_only_records WHERE log_name = $1', [TODAY]);
    expect(n.rows[0]!.n).toBe('1');
  }, 60_000);

  it('research:status reads through a read-only session and read-only stores: it writes nothing and PostgreSQL refuses writes', async () => {
    const db = await database();
    const h = harness({ stores: await pgStores(db.pool), lock: new PostgresWorkerLock(db.pool), catalog: catalogOf([AAPL_ENTRY, BTC_ENTRY]) });
    await h.run();
    const before = await db.pool.query<{ logs: string; records: string; bars: string }>('SELECT (SELECT count(*) FROM append_only_logs)::text AS logs, (SELECT count(*) FROM append_only_records)::text AS records, (SELECT count(*) FROM market_bars)::text AS bars');
    const ro = openResearchPool(urlOf(db), { readOnly: true, applicationName: 'nexus-research-status-test' });
    try {
      const stores = openResearchStoresReadOnly(ro);
      // A log of a day without runs is NOT created by reading it.
      const logs = { yesterday: await stores.openRunLog(researchRunLogName(Date.parse(NOW) - 86_400_000)), today: await stores.openRunLog(TODAY) };
      const status = await researchStatus({ catalog: catalogOf([AAPL_ENTRY, BTC_ENTRY]), records: recordsOf(logs), marketData: stores.marketData, sourceId: RESEARCH_SOURCE_ID, budget: { dailyCredits: 400, minuteCredits: 6 }, nowMs: Date.parse(NOW) });
      expect(status.lastRun).toMatchObject({ status: 'completed', creditsUsed: 2 });
      expect(status.instruments.map((i) => [i.instrumentId, i.barsLast24h])).toEqual([['rsx_xnas_aapl', 7], ['rsx_crypto_btcusd', 7]]);
      await expect(logs.today.append('x', { schema: 'research-run:v1', kind: 'run_skipped', runId: 'x', at: NOW, reason: 'LOCK_HELD' })).rejects.toThrow(/read-only/);
      await expect(ro.query("INSERT INTO append_only_logs (log_name) VALUES ('research-runs-v1.2099-01-01')")).rejects.toThrow(/read-only/);
      await expect(ro.query('CREATE TABLE research_probe (x int)')).rejects.toThrow(/read-only/);
      await expect(new PostgresMarketDataStore(ro).registerSource({ sourceId: 'x:y:demo', provider: 'x', dataset: 'y', environment: 'demo', license: 'unreviewed' })).rejects.toThrow(/read-only/);
    } finally {
      await ro.end();
    }
    const after = await db.pool.query('SELECT (SELECT count(*) FROM append_only_logs)::text AS logs, (SELECT count(*) FROM append_only_records)::text AS records, (SELECT count(*) FROM market_bars)::text AS bars');
    expect(after.rows[0]).toEqual(before.rows[0]);
  }, 60_000);

  it('the database identity is checked on the open connection, and the schema must be exactly the repository migrations', async () => {
    const db = await database();
    if (!pgInfo.available) throw new Error('no pg');
    await assertResearchDatabase(db.pool, { name: db.name, user: pgInfo.connection.user });
    await expect(assertResearchDatabase(db.pool, { name: 'nexus', user: pgInfo.connection.user })).rejects.toThrow(ResearchDatabaseError);
    await expect(assertResearchDatabase(db.pool, { name: db.name, user: 'nexus_research_app' })).rejects.toThrow(ResearchDatabaseError);
    const admin = await db.privilegedClient();
    try {
      await admin.query('DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)');
    } finally {
      await admin.end();
    }
    await expect(assertResearchDatabase(db.pool, { name: db.name, user: pgInfo.connection.user })).rejects.toThrow(/not up to date/);
  }, 60_000);

  it('the instrument registry the worker writes is the same projected registry the runtime reads', async () => {
    const db = await database();
    const h = harness({ stores: await pgStores(db.pool), lock: new PostgresWorkerLock(db.pool), catalog: catalogOf([BTC_ENTRY]) });
    await h.run();
    const store = await PostgresAppendOnlyStore.open<InstrumentEvent>(db.pool, 'instruments', { projector: instrumentProjector });
    expect((await store.loadAll()).map((r) => r.payload.type)).toEqual(['instrument_registered']);
    const projected = await db.pool.query<{ instrument_id: string }>('SELECT instrument_id FROM instruments');
    expect(projected.rows.map((r) => r.instrument_id)).toEqual(['rsx_crypto_btcusd']);
  }, 60_000);
});
