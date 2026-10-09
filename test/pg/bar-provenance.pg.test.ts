import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { barContentHash } from '../../src/market-data/bar-validation.js';
import { MarketDataIntegrityError, InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import type { BarRevisionKnowledge, MarketBar } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { loadMigrations, migrate } from '../../src/persistence/postgres/migrator.js';
import { createPool } from '../../src/persistence/postgres/pool.js';
import { PostgresMarketDataStore } from '../../src/persistence/postgres/postgres-market-data-store.js';
import { AAPL, FIXTURE_SOURCE, dailyBars } from '../market-data/fixtures.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

// Market bar provenance on PostgreSQL (F9). See docs/MARKET_BAR_PROVENANCE.md.

const XNAS = getCalendar('XNAS')!;
const SERIES = { instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, interval: '1d' as const, session: 'regular' as const, adjustment: 'raw' as const };
const ROW = (close: string) => ({ open: close, high: close, low: close, close, volume: '1000' });
const HASH = 'a'.repeat(64);
const HISTORICAL: BarRevisionKnowledge = { provenance: 'historical_bar_reconstruction', revisionKnownAt: null };

function daily(date: string, close: string, retrievedAt: string, knowledge: BarRevisionKnowledge): MarketBar {
  const [bar] = dailyBars(XNAS, date, [ROW(close)], { retrievedAt });
  return { ...bar!, knowledge } as MarketBar;
}

/** Column list and values for a direct insert into market_bars (the application path is tested elsewhere). */
const INSERT_BAR = `INSERT INTO market_bars (instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash, knowledge_provenance, revision_known_at, provenance_hash)
  VALUES ('ins_aapl', $1, '1d', 'regular', 'raw', $2, $3, $4, 250, 250, 250, 250, 1000, true, $5, $6, $7, $8, $9, $10, $11, $12)`;

describe.skipIf(!pgAvailable)('market bar provenance on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => {
    await db?.drop();
    db = null;
  });

  async function fresh(): Promise<TestDatabase> {
    db = await createTestDatabase();
    await new PostgresMarketDataStore(db.extraPool()).registerSource(FIXTURE_SOURCE);
    return db;
  }

  // F — the database accepts only the combinations of provenance, revisionKnownAt and retrievedAt that the model allows.
  describe('F: database combinations', () => {
    const bar = ['2026-09-25T00:00:00Z', '2026-09-25T20:00:00Z', '2026-09-25T20:02:00Z'];
    const insert = (d: TestDatabase, provenance: string | null, known: string | null, revision = 1, extra: { observed?: string; available?: string; retrieved?: string } = {}) =>
      d.pool.query(INSERT_BAR, [
        FIXTURE_SOURCE.sourceId,
        bar[0],
        '2026-09-25T20:00:00Z',
        revision,
        extra.observed ?? bar[1],
        extra.available ?? bar[1],
        extra.retrieved ?? bar[2],
        revision,
        HASH,
        provenance,
        known,
        HASH,
      ]);

    it('a captured revision must be known exactly at its retrieval', async () => {
      const d = await fresh();
      await expect(insert(d, 'captured_by_nexus', '2026-09-25T20:01:00Z')).rejects.toThrow(/market_bars_captured_is_retrieval/);
    });

    it('a historical reconstruction has no knowledge time', async () => {
      const d = await fresh();
      await expect(insert(d, 'historical_bar_reconstruction', '2026-09-25T20:02:00Z')).rejects.toThrow(/market_bars_knowledge_shape/);
    });

    it('a provider publication time cannot be later than the retrieval', async () => {
      const d = await fresh();
      await expect(insert(d, 'provider_published_at', '2026-09-25T21:00:00Z')).rejects.toThrow(/market_bars_knowledge_shape/);
    });

    it('a proven final bar cannot be known before its completion', async () => {
      const d = await fresh();
      await expect(insert(d, 'captured_by_nexus', '2026-09-25T19:59:00Z', 1, { retrieved: '2026-09-25T19:59:00Z' })).rejects.toThrow(/market_bars_knowledge_not_before_completion/);
    });

    it('a legacy or unknown provenance label is refused', async () => {
      const d = await fresh();
      await expect(insert(d, 'legacy_unproven', null)).rejects.toThrow(/market_bars_knowledge_provenance_values/);
    });

    it('a new row must state its provenance', async () => {
      const d = await fresh();
      await expect(insert(d, null, null)).rejects.toThrow(/market_bars_provenance_required/);
    });

    it('a revision cannot become available before its knowledge (revision 2 of a captured bar)', async () => {
      const d = await fresh();
      await insert(d, 'historical_bar_reconstruction', null, 1);
      await expect(insert(d, 'captured_by_nexus', '2026-09-26T09:00:00Z', 2, { available: '2026-09-25T20:05:00Z', retrieved: '2026-09-26T09:00:00Z' })).rejects.toThrow(
        /cannot become available before it was retrieved or known/,
      );
    });

    it('a later revision cannot be known before an earlier proven revision', async () => {
      const d = await fresh();
      await insert(d, 'captured_by_nexus', '2026-09-25T20:02:00Z', 1);
      await expect(insert(d, 'captured_by_nexus', '2026-09-25T20:01:30Z', 2, { available: '2026-09-26T09:00:00Z', retrieved: '2026-09-25T20:01:30Z' })).rejects.toThrow(
        /cannot be known before an earlier revision/,
      );
    });
  });

  it('roundtrip: a fresh process reads the same provenance; strict replay refuses the unproven revision and keeps the captured one', async () => {
    const d = await fresh();
    const writer = new PostgresMarketDataStore(d.pool);
    await writer.ingestBars(AAPL, [daily('2026-09-24', '250', '2026-10-07T13:57:30.000Z', HISTORICAL)], '2026-10-07T13:57:30.000Z');
    await writer.ingestBars(AAPL, [daily('2026-09-28', '251', '2026-09-28T20:02:00.000Z', { provenance: 'captured_by_nexus', revisionKnownAt: '2026-09-28T20:02:00.000Z' })], '2026-09-28T20:02:00.000Z');
    const reader = new PostgresMarketDataStore(d.extraPool());
    const historical = await reader.readBars({ ...SERIES, asOf: '2026-10-07T12:00:00.000Z', replay: 'historical_reconstruction' });
    expect(historical.map((b) => [b.startTime.slice(0, 10), b.knowledge])).toEqual([
      ['2026-09-24', HISTORICAL],
      ['2026-09-28', { provenance: 'captured_by_nexus', revisionKnownAt: '2026-09-28T20:02:00.000Z' }],
    ]);
    await expect(reader.readBars({ ...SERIES, asOf: '2026-10-07T12:00:00.000Z', replay: 'strict_point_in_time' })).rejects.toMatchObject({ code: 'BAR_VINTAGE_NOT_PROVEN' });
    const strictSince = await reader.readBars({ ...SERIES, from: '2026-09-28T00:00:00Z', asOf: '2026-10-07T12:00:00.000Z', replay: 'strict_point_in_time' });
    expect(strictSince.map((b) => b.close.toString())).toEqual(['251']);
  });

  // G — a privileged change of the knowledge provenance (which passes every CHECK) is detected on read.
  it('G: a privileged change of a historical revision into a captured one is detected on read (fail closed)', async () => {
    const d = await fresh();
    await new PostgresMarketDataStore(d.pool).ingestBars(AAPL, [daily('2026-09-24', '250', '2026-10-07T13:57:30.000Z', HISTORICAL)], '2026-10-07T13:57:30.000Z');
    const privileged = await d.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'"); // disables triggers: a superuser bypassing NEXUS
      await privileged.query("UPDATE market_bars SET knowledge_provenance = 'captured_by_nexus', revision_known_at = retrieved_at WHERE start_time = '2026-09-24T04:00:00Z'");
    } finally {
      await privileged.end();
    }
    await expect(new PostgresMarketDataStore(d.extraPool()).readBars({ ...SERIES, asOf: '2026-10-08T00:00:00.000Z', replay: 'historical_reconstruction' })).rejects.toBeInstanceOf(MarketDataIntegrityError);
  });

  // E — migration 008 on existing data: legacy rows keep their values and get no invented provenance.
  it('E: migration 008 on existing rows: legacy bars are not rewritten and are labelled legacy_unproven, never strict', async () => {
    if (!pgInfo.available) throw new Error('PostgreSQL not available: ' + pgInfo.reason);
    const { connection, adminDatabase } = pgInfo;
    const name = 'nexus_t_bar_mig_' + randomBytes(6).toString('hex');
    const admin = new pg.Client({ ...connection, database: adminDatabase });
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query('CREATE DATABASE ' + name);
    await admin.end();
    const pool = createPool({ ...connection, database: name, max: 2, applicationName: 'nexus-test' });
    const legacy = daily('2020-08-27', '400', '2026-10-07T13:57:30.000Z', HISTORICAL);
    const AT = '2026-10-08T00:00:00.000Z';
    try {
      await migrate(pool, loadMigrations().filter((m) => m.version <= 7));
      await new PostgresMarketDataStore(pool).registerSource(FIXTURE_SOURCE);
      // Written the way the previous code wrote it: observed_at = available_at = completion, retrieved years later.
      await pool.query(
        `INSERT INTO market_bars (instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash)
         VALUES ($1, $2, '1d', 'regular', 'raw', $3, $4, 1, 400, 400, 400, 400, 1000, true, $5, $5, $6, 1, $7)`,
        [AAPL.instrumentId, FIXTURE_SOURCE.sourceId, legacy.startTime, legacy.endTime, legacy.observedAt, legacy.retrievedAt, barContentHash(legacy)],
      );
      const applied = await migrate(pool, loadMigrations());
      expect(applied.applied).toEqual([8]);

      const row = (await pool.query("SELECT observed_at, available_at, retrieved_at, knowledge_provenance, revision_known_at, provenance_hash FROM market_bars WHERE start_time = $1", [legacy.startTime])).rows[0];
      expect(row).toEqual({
        observed_at: new Date(legacy.observedAt),
        available_at: new Date(legacy.observedAt),
        retrieved_at: new Date(legacy.retrievedAt),
        knowledge_provenance: null,
        revision_known_at: null,
        provenance_hash: null,
      });

      const store = new PostgresMarketDataStore(pool);
      const [seen] = await store.readBars({ ...SERIES, asOf: AT, replay: 'historical_reconstruction' });
      expect(seen!.knowledge).toEqual({ provenance: 'legacy_unproven', revisionKnownAt: null });
      await expect(store.readBars({ ...SERIES, asOf: AT, replay: 'strict_point_in_time' })).rejects.toMatchObject({ code: 'BAR_VINTAGE_NOT_PROVEN' });
    } finally {
      await pool.end();
      const drop = new pg.Client({ ...connection, database: adminDatabase });
      drop.on('error', () => undefined);
      await drop.connect();
      await drop.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
      await drop.end();
    }
  });

  it('the in-memory and PostgreSQL stores agree on the same strict and historical reads', async () => {
    const d = await fresh();
    const bars = [daily('2026-09-24', '250', '2026-10-07T13:57:30.000Z', HISTORICAL), daily('2026-09-28', '251', '2026-09-28T20:02:00.000Z', { provenance: 'captured_by_nexus', revisionKnownAt: '2026-09-28T20:02:00.000Z' })];
    const memory = new InMemoryMarketDataStore();
    await memory.registerSource(FIXTURE_SOURCE);
    await memory.ingestBars(AAPL, bars, '2026-10-07T13:57:30.000Z');
    await new PostgresMarketDataStore(d.pool).ingestBars(AAPL, bars, '2026-10-07T13:57:30.000Z');
    const asOf = '2026-10-07T12:00:00.000Z';
    const pgHistorical = await new PostgresMarketDataStore(d.extraPool()).readBars({ ...SERIES, asOf, replay: 'historical_reconstruction' });
    expect(pgHistorical).toEqual(await memory.readBars({ ...SERIES, asOf, replay: 'historical_reconstruction' }));
    const since = { ...SERIES, from: '2026-09-28T00:00:00Z', asOf: '2026-09-29T00:00:00Z', replay: 'strict_point_in_time' as const };
    expect(await new PostgresMarketDataStore(d.extraPool()).readBars(since)).toEqual(await memory.readBars(since));
  });
});
