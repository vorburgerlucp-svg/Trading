import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { BAR_VINTAGE_POLICY_VERSION } from '../../src/market-data/bar-vintage.js';
import { barContentHash } from '../../src/market-data/bar-validation.js';
import { InMemoryMarketDataStore, MarketDataIntegrityError } from '../../src/market-data/market-data-store.js';
import type { BarRevisionKnowledge, MarketBar } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { loadMigrations, migrate } from '../../src/persistence/postgres/migrator.js';
import { createPool } from '../../src/persistence/postgres/pool.js';
import { PostgresMarketDataStore } from '../../src/persistence/postgres/postgres-market-data-store.js';
import { AAPL, FIXTURE_SOURCE, PRODUCTION_LIKE_SOURCE, dailyBars } from '../market-data/fixtures.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

// Bar knowledge on PostgreSQL: the store writes and reads both models; the database rules are in schema-history.pg.test.ts.

const XNAS = getCalendar('XNAS')!;
const SERIES = { instrumentId: AAPL.instrumentId, source: PRODUCTION_LIKE_SOURCE.sourceId, interval: '1d' as const, session: 'regular' as const, adjustment: 'raw' as const };
const ROW = (close: string) => ({ open: close, high: close, low: close, close, volume: '1000' });
const POLICY = BAR_VINTAGE_POLICY_VERSION;
const received = (retrievedAt: string, vintage: 'contemporaneous' | 'historical_reconstruction'): BarRevisionKnowledge => ({
  knownAt: retrievedAt,
  knowledgeSource: 'captured_by_nexus',
  vintage,
  vintagePolicy: POLICY,
});

function bar(date: string, close: string, retrievedAt: string, knowledge: BarRevisionKnowledge): MarketBar {
  const [b] = dailyBars(XNAS, date, [ROW(close)], { retrievedAt, source: PRODUCTION_LIKE_SOURCE.sourceId });
  return { ...b!, knowledge };
}

describe.skipIf(!pgAvailable)('bar knowledge on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => {
    await db?.drop();
    db = null;
  });
  async function fresh(): Promise<TestDatabase> {
    db = await createTestDatabase();
    const store = new PostgresMarketDataStore(db.extraPool());
    await store.registerSource(FIXTURE_SOURCE);
    await store.registerSource(PRODUCTION_LIKE_SOURCE);
    return db;
  }

  it('roundtrip: a fresh process reads the same knowledge, decision-time and research modes as the in-memory store', async () => {
    const d = await fresh();
    const backfill = bar('2026-09-24', '250', '2026-10-09T12:00:00.000Z', received('2026-10-09T12:00:00.000Z', 'historical_reconstruction'));
    const live = bar('2026-09-25', '251', '2026-09-25T20:02:00.000Z', received('2026-09-25T20:02:00.000Z', 'contemporaneous'));
    const memory = new InMemoryMarketDataStore();
    await memory.registerSource(PRODUCTION_LIKE_SOURCE);
    await memory.ingestBars(AAPL, [backfill, live], '2026-10-09T12:00:00.000Z');
    await new PostgresMarketDataStore(d.pool).ingestBars(AAPL, [backfill, live], '2026-10-09T12:00:00.000Z');
    const reader = new PostgresMarketDataStore(d.extraPool());
    for (const [asOf, replay] of [
      ['2026-10-09T12:30:00.000Z', 'decision_time'],
      ['2026-10-09T11:59:00.000Z', 'decision_time'],
      ['2025-06-01T00:00:00.000Z', 'historical_research'],
    ] as const) {
      expect(await reader.readBars({ ...SERIES, asOf, replay })).toEqual(await memory.readBars({ ...SERIES, asOf, replay }));
    }
    const decision = await reader.readBars({ ...SERIES, asOf: '2026-10-09T12:30:00.000Z', replay: 'decision_time' });
    expect(decision.map((b) => [b.startTime.slice(0, 10), b.knowledge.knownAt, b.knowledge.vintage])).toEqual([
      ['2026-09-24', '2026-10-09T12:00:00.000Z', 'historical_reconstruction'],
      ['2026-09-25', '2026-09-25T20:02:00.000Z', 'contemporaneous'],
    ]);
  });

  it('a privileged change that passes every CHECK (the availability gate) is detected on read by the knowledge hash', async () => {
    const d = await fresh();
    await new PostgresMarketDataStore(d.pool).ingestBars(AAPL, [bar('2026-09-24', '250', '2026-10-09T12:00:00.000Z', received('2026-10-09T12:00:00.000Z', 'historical_reconstruction'))], '2026-10-09T12:00:00.000Z');
    const privileged = await d.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'"); // a superuser bypassing NEXUS's triggers (CHECK constraints still apply)
      // Later than its observation and still within every constraint, but not the value NEXUS stored.
      await privileged.query("UPDATE market_bars SET available_at = available_at + INTERVAL '1 hour' WHERE start_time = '2026-09-24T04:00:00Z'");
    } finally {
      await privileged.end();
    }
    await expect(new PostgresMarketDataStore(d.extraPool()).readBars({ ...SERIES, asOf: '2026-10-10T00:00:00.000Z', replay: 'historical_research' })).rejects.toBeInstanceOf(MarketDataIntegrityError);
  });

  it('a privileged change of the 008 integrity hash is detected on read', async () => {
    const d = await fresh();
    await new PostgresMarketDataStore(d.pool).ingestBars(AAPL, [bar('2026-09-24', '250', '2026-10-09T12:00:00.000Z', received('2026-10-09T12:00:00.000Z', 'historical_reconstruction'))], '2026-10-09T12:00:00.000Z');
    const privileged = await d.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'");
      await privileged.query("UPDATE market_bars SET provenance_hash = $1 WHERE start_time = '2026-09-24T04:00:00Z'", ['e'.repeat(64)]);
    } finally {
      await privileged.end();
    }
    await expect(new PostgresMarketDataStore(d.extraPool()).readBars({ ...SERIES, asOf: '2026-10-10T00:00:00.000Z', replay: 'historical_research' })).rejects.toBeInstanceOf(MarketDataIntegrityError);
  });

  // Migration 008 + 009 on existing data: legacy rows keep their values and get no invented knowledge.
  it('legacy rows written before provenance: not rewritten, no invented knownAt, refused by decision-time replay, labelled in research', async () => {
    if (!pgInfo.available) throw new Error('PostgreSQL not available: ' + pgInfo.reason);
    const { connection, adminDatabase } = pgInfo;
    const name = 'nexus_t_knowledge_mig_' + randomBytes(6).toString('hex');
    const admin = new pg.Client({ ...connection, database: adminDatabase });
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query('CREATE DATABASE ' + name);
    await admin.end();
    const pool = createPool({ ...connection, database: name, max: 2, applicationName: 'nexus-test' });
    const legacy = dailyBars(XNAS, '2020-01-10', [ROW('400')], { retrievedAt: '2026-10-09T12:00:00.000Z', source: PRODUCTION_LIKE_SOURCE.sourceId })[0]! as MarketBar;
    try {
      await migrate(pool, loadMigrations().filter((m) => m.version <= 7));
      await new PostgresMarketDataStore(pool).registerSource(PRODUCTION_LIKE_SOURCE);
      await pool.query(
        `INSERT INTO market_bars (instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash)
         VALUES ($1, $2, '1d', 'regular', 'raw', $3, $4, 1, 400, 400, 400, 400, 1000, true, $5, $5, $6, 1, $7)`,
        [AAPL.instrumentId, PRODUCTION_LIKE_SOURCE.sourceId, legacy.startTime, legacy.endTime, legacy.observedAt, legacy.retrievedAt, barContentHash(legacy)],
      );
      const applied = await migrate(pool, loadMigrations());
      expect(applied.applied).toEqual([8, 9]);
      const row = (await pool.query('SELECT observed_at, available_at, retrieved_at, knowledge_provenance, revision_known_at, provenance_hash, knowledge_source_v2, known_at_v2, vintage_v2, vintage_policy_v2, knowledge_vintage_hash FROM market_bars WHERE start_time = $1', [legacy.startTime])).rows[0];
      expect(row).toEqual({
        observed_at: new Date(legacy.observedAt),
        available_at: new Date(legacy.observedAt),
        retrieved_at: new Date(legacy.retrievedAt),
        knowledge_provenance: null,
        revision_known_at: null,
        provenance_hash: null,
        knowledge_source_v2: null,
        known_at_v2: null,
        vintage_v2: null,
        vintage_policy_v2: null,
        knowledge_vintage_hash: null,
      });
      const store = new PostgresMarketDataStore(pool);
      const [research] = await store.readBars({ ...SERIES, asOf: '2026-10-10T00:00:00.000Z', replay: 'historical_research' });
      expect(research!.knowledge).toMatchObject({ knownAt: null, knowledgeSource: 'legacy_unproven', vintage: 'legacy_unproven' });
      await expect(store.readBars({ ...SERIES, asOf: '2026-10-10T00:00:00.000Z', replay: 'decision_time' })).rejects.toMatchObject({ code: 'BAR_KNOWLEDGE_NOT_PROVEN' });
    } finally {
      await pool.end();
      const drop = new pg.Client({ ...connection, database: adminDatabase });
      drop.on('error', () => undefined);
      await drop.connect();
      await drop.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
      await drop.end();
    }
  });
});
