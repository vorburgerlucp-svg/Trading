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

// Bar knowledge on PostgreSQL (see docs/BAR_KNOWLEDGE_EVIDENCE.md).

const XNAS = getCalendar('XNAS')!;
const SERIES = { instrumentId: AAPL.instrumentId, source: PRODUCTION_LIKE_SOURCE.sourceId, interval: '1d' as const, session: 'regular' as const, adjustment: 'raw' as const };
const ROW = (close: string) => ({ open: close, high: close, low: close, close, volume: '1000' });
const HASH = 'a'.repeat(64);
const POLICY = BAR_VINTAGE_POLICY_VERSION;
const received = (retrievedAt: string, vintage: 'contemporaneous' | 'historical_reconstruction' = 'historical_reconstruction'): BarRevisionKnowledge & { vintage: string; vintagePolicy: string } => ({
  knownAt: retrievedAt,
  knowledgeSource: 'captured_by_nexus',
  vintage,
  vintagePolicy: POLICY,
} as BarRevisionKnowledge & { vintage: string; vintagePolicy: string });

function bar(date: string, close: string, retrievedAt: string, knowledge: unknown): MarketBar {
  const [b] = dailyBars(XNAS, date, [ROW(close)], { retrievedAt, source: PRODUCTION_LIKE_SOURCE.sourceId });
  return { ...b!, knowledge } as unknown as MarketBar;
}

/** Direct insert of one revision. The application path is tested through the store below. */
const INSERT = `INSERT INTO market_bars (instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash, knowledge_source, known_at, vintage, vintage_policy, provenance_hash)
  VALUES ('ins_aapl', $1, '1d', 'regular', 'raw', '2026-09-25T04:00:00Z', '2026-09-26T04:00:00Z', $2::integer, 250, 250, 250, 250, 1000, true, '2026-09-25T20:00:00Z', '2026-09-25T20:00:00Z', $3, $2::bigint, $8, $4, $5, $6, $7, $8)`;

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
  const insert = (d: TestDatabase, revision: number, retrieved: string, source: string | null, knownAt: string | null, vintage: string | null, policy: string | null = POLICY) =>
    d.pool.query(INSERT, [PRODUCTION_LIKE_SOURCE.sourceId, revision, retrieved, source, knownAt, vintage, policy, HASH]);

  describe('the database accepts only the combinations the model allows', () => {
    it('a captured revision is known exactly at its retrieval', async () => {
      const d = await fresh();
      await expect(insert(d, 1, '2026-09-25T20:02:00Z', 'captured_by_nexus', '2026-09-25T20:01:00Z', 'contemporaneous')).rejects.toThrow(/market_bars_captured_is_retrieval|market_bars_knowledge_shape/);
    });

    it('a backfill is known at its retrieval, not at its completion (no knowledge before retrieval)', async () => {
      const d = await fresh();
      await expect(insert(d, 1, '2026-10-09T12:00:00Z', 'captured_by_nexus', '2026-10-09T12:00:00Z', 'historical_reconstruction')).resolves.toBeDefined();
    });

    it('a provider publication time cannot be later than the retrieval', async () => {
      const d = await fresh();
      await expect(insert(d, 1, '2026-09-25T20:02:00Z', 'provider_published_at', '2026-09-25T21:00:00Z', 'contemporaneous')).rejects.toThrow(/market_bars_knowledge_shape/);
    });

    it('a known source needs a vintage and a vintage policy', async () => {
      const d = await fresh();
      await expect(insert(d, 1, '2026-09-25T20:02:00Z', 'captured_by_nexus', '2026-09-25T20:02:00Z', null, null)).rejects.toThrow(/market_bars_knowledge_shape|market_bars_provenance_required/);
    });

    it('a vintage without a knowledge source is refused (the two questions are not mixed)', async () => {
      const d = await fresh();
      await expect(insert(d, 1, '2026-09-25T20:02:00Z', null, null, 'contemporaneous', null)).rejects.toThrow(/market_bars_knowledge_shape/);
    });

    it('a final bar cannot be known before it was complete', async () => {
      const d = await fresh();
      // Ten minutes before completion is beyond the five minutes of retrieval clock skew the application tolerates.
      await expect(insert(d, 1, '2026-09-25T19:50:00Z', 'captured_by_nexus', '2026-09-25T19:50:00Z', 'contemporaneous')).rejects.toThrow(/market_bars_knowledge_not_before_completion/);
    });

    it('legacy_unproven is not a stored label: a legacy row carries NULL, and new rows must state their knowledge', async () => {
      const d = await fresh();
      await expect(insert(d, 1, '2026-09-25T20:02:00Z', 'legacy_unproven', null, 'legacy_unproven')).rejects.toThrow(/market_bars_knowledge_source_values|market_bars_knowledge_shape/);
      await expect(insert(d, 1, '2026-09-25T20:02:00Z', null, null, null, null)).rejects.toThrow(/market_bars_provenance_required/);
    });

    it('the vintage must be one of the two proven values', async () => {
      const d = await fresh();
      await expect(insert(d, 1, '2026-09-25T20:02:00Z', 'captured_by_nexus', '2026-09-25T20:02:00Z', 'guessed')).rejects.toThrow(/market_bars_vintage_values/);
    });

    it('a later revision cannot be known before an earlier one', async () => {
      const d = await fresh();
      await insert(d, 1, '2026-10-09T12:00:00Z', 'captured_by_nexus', '2026-10-09T12:00:00Z', 'historical_reconstruction');
      await expect(insert(d, 2, '2026-10-08T09:00:00Z', 'captured_by_nexus', '2026-10-08T09:00:00Z', 'historical_reconstruction')).rejects.toThrow(/cannot be known before an earlier revision|cannot become available before it was retrieved or known/);
    });
  });

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

  it('a privileged change of the vintage (which passes every CHECK) is detected on read', async () => {
    const d = await fresh();
    await new PostgresMarketDataStore(d.pool).ingestBars(AAPL, [bar('2026-09-24', '250', '2026-10-09T12:00:00.000Z', received('2026-10-09T12:00:00.000Z', 'historical_reconstruction'))], '2026-10-09T12:00:00.000Z');
    const privileged = await d.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'"); // a superuser bypassing NEXUS
      await privileged.query("UPDATE market_bars SET vintage = 'contemporaneous' WHERE start_time = '2026-09-24T04:00:00Z'");
    } finally {
      await privileged.end();
    }
    await expect(new PostgresMarketDataStore(d.extraPool()).readBars({ ...SERIES, asOf: '2026-10-10T00:00:00.000Z', replay: 'decision_time' })).rejects.toBeInstanceOf(MarketDataIntegrityError);
  });

  // Migration 008 on existing data: legacy rows keep their values and get no invented knowledge.
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
    const legacy = dailyBars(XNAS, '2020-01-10', [ROW('400')], { retrievedAt: '2026-10-09T12:00:00.000Z', source: PRODUCTION_LIKE_SOURCE.sourceId })[0]!;
    try {
      await migrate(pool, loadMigrations().filter((m) => m.version <= 7));
      await new PostgresMarketDataStore(pool).registerSource(PRODUCTION_LIKE_SOURCE);
      await pool.query(
        `INSERT INTO market_bars (instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash)
         VALUES ($1, $2, '1d', 'regular', 'raw', $3, $4, 1, 400, 400, 400, 400, 1000, true, $5, $5, $6, 1, $7)`,
        [AAPL.instrumentId, PRODUCTION_LIKE_SOURCE.sourceId, legacy.startTime, legacy.endTime, legacy.observedAt, legacy.retrievedAt, barContentHash(legacy)],
      );
      const applied = await migrate(pool, loadMigrations());
      expect(applied.applied).toEqual([8]);
      const row = (await pool.query("SELECT observed_at, available_at, retrieved_at, knowledge_source, known_at, vintage, vintage_policy, provenance_hash FROM market_bars WHERE start_time = $1", [legacy.startTime])).rows[0];
      expect(row).toEqual({
        observed_at: new Date(legacy.observedAt),
        available_at: new Date(legacy.observedAt),
        retrieved_at: new Date(legacy.retrievedAt),
        knowledge_source: null,
        known_at: null,
        vintage: null,
        vintage_policy: null,
        provenance_hash: null,
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
