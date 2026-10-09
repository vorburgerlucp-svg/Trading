import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { barContentHash } from '../../src/market-data/bar-validation.js';
import { BAR_VINTAGE_POLICY_VERSION, barVintageOf } from '../../src/market-data/bar-vintage.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { loadMigrations, migrate, type Migration } from '../../src/persistence/postgres/migrator.js';
import { createPool, type PgPool } from '../../src/persistence/postgres/pool.js';
import { PostgresMarketDataStore } from '../../src/persistence/postgres/postgres-market-data-store.js';
import { AAPL, PRODUCTION_LIKE_SOURCE, dailyBars } from '../market-data/fixtures.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';
import { putRawBar, type RawBar } from './bar-rows.js';

// Schema history (see docs/MIGRATION_HISTORY.md). The upgrade from the ORIGINAL migration 008 is the critical test: a database that
// applied the committed 008 upgrades through 009 without touching 008 or its rows, and the old rows keep their meaning.

const XNAS = getCalendar('XNAS')!;
const ROW = (close: string) => ({ open: close, high: close, low: close, close, volume: '1000' });
const SOURCE = PRODUCTION_LIKE_SOURCE.sourceId;
const SERIES = { instrumentId: AAPL.instrumentId, source: SOURCE, interval: '1d' as const, session: 'regular' as const, adjustment: 'raw' as const };

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGINAL_008_PATH = join(HERE, '..', 'fixtures', 'migrations', '008_market_bar_provenance.de4c3f4.sql');
/** Checksums of the committed history. A change to any of these is a change to committed history. */
const CHECKSUM_008 = 'c8f14c983ead6a38fa14f08f298b3d228690603475e78084c8378a607f36861e';
const CHECKSUM_009 = 'b2812e5e40906c397d914cac6af646d48f89154f8b3356fc2672bd8805cdf5ec';
/** Values computed by the ORIGINAL release (de4c3f4): the content hash, and the 008 integrity hash of the same row. */
const A_CONTENT = '8acf3d64663df037999606308e7436ea0d422d131fe1faeb69b206fbfe893fbc';
const A_V1 = '8e2b079755058fff8332f0398a767caa72bef0f9dd9e9e955e65f8981df6382c';
const B_CONTENT = '2a07c33c7fc6aece9c3f933ff17db2afbdf9d1073c399c5ded87f2a19fe99c46';
const B_V1 = 'ef087abb316730ba33a8d0cf41e3a1c7fa73261ab335a577aa361ff8b0e62844';

function originalMigration008(): Migration {
  const sql = readFileSync(ORIGINAL_008_PATH, 'utf8').replace(/\r\n/g, '\n');
  return { version: 8, name: 'market_bar_provenance', sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

/** The knowledge of a bar NEXUS captured: contemporaneous or not, by the vintage policy and the actual completion. */
function captured(bar: MarketBar, retrievedAt: string): MarketBar {
  return {
    ...bar,
    knowledge: {
      knownAt: retrievedAt,
      knowledgeSource: 'captured_by_nexus',
      vintage: barVintageOf({ observedAt: bar.observedAt, retrievedAt, isFinal: bar.isFinal, interval: bar.interval }),
      vintagePolicy: BAR_VINTAGE_POLICY_VERSION,
    },
  };
}

/** A revision as the ORIGINAL release wrote it: the 008 columns only (the V2 model did not exist yet). */
async function putOriginal(pool: PgPool, bar: MarketBar, seq: number, provenance: string | null, known: string | null, hash: string | null, content: string): Promise<void> {
  await pool.query(
    `INSERT INTO market_bars (instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash, knowledge_provenance, revision_known_at, provenance_hash)
     VALUES ($1, $2, '1d', 'regular', 'raw', $3, $4, 1, $5, $5, $5, $5, 1000, true, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [bar.instrumentId, bar.source, bar.startTime, bar.endTime, bar.close.toString(), bar.observedAt, bar.availableAt, bar.retrievedAt, seq, content, provenance, known, hash],
  );
}

/** A row from before provenance existed: the columns of 007 only (written before 008 is applied). */
async function putLegacy(pool: PgPool, bar: MarketBar, seq: number): Promise<void> {
  await pool.query(
    `INSERT INTO market_bars (instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash)
     VALUES ($1, $2, '1d', 'regular', 'raw', $3, $4, 1, $5, $5, $5, $5, 1000, true, $6, $7, $8, $9, $10)`,
    [bar.instrumentId, bar.source, bar.startTime, bar.endTime, bar.close.toString(), bar.observedAt, bar.availableAt, bar.retrievedAt, seq, barContentHash(bar)],
  );
}

/** Every column of the 008 era, as text: the snapshot that must not change when 009 is applied. */
async function snapshot(pool: PgPool): Promise<unknown[]> {
  return (
    await pool.query(
      `SELECT instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open::text AS open, high::text AS high, low::text AS low, close::text AS close,
              volume::text AS volume, is_final, observed_at, available_at, retrieved_at, ingest_seq::text AS ingest_seq, content_hash, knowledge_provenance, revision_known_at, provenance_hash
         FROM market_bars ORDER BY start_time, revision`,
    )
  ).rows;
}

async function checksumOf(pool: PgPool, version: number): Promise<string> {
  return (await pool.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = $1', [version])).rows[0]!.checksum;
}

/** A PostgreSQL database that has NO migrations yet (the template already has all of them). */
async function bareDatabase(): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  if (!pgInfo.available) throw new Error('PostgreSQL not available: ' + pgInfo.reason);
  const { connection, adminDatabase } = pgInfo;
  const name = 'nexus_t_history_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ ...connection, database: adminDatabase });
  admin.on('error', () => undefined);
  await admin.connect();
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();
  const pool = createPool({ ...connection, database: name, max: 4, applicationName: 'nexus-test' });
  return {
    pool,
    drop: async () => {
      await pool.end();
      const drop = new pg.Client({ ...connection, database: adminDatabase });
      drop.on('error', () => undefined);
      await drop.connect();
      await drop.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
      await drop.end();
    },
  };
}

describe.skipIf(!pgAvailable)('schema history on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  it('the committed 008 is the historical one, and 009 is the next migration', () => {
    const migrations = loadMigrations();
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(migrations.find((m) => m.version === 8)!.checksum).toBe(CHECKSUM_008);
    expect(migrations.find((m) => m.version === 9)!.checksum).toBe(CHECKSUM_009);
    expect(originalMigration008().checksum).toBe(CHECKSUM_008);
  });

  // ---- A) THE CRITICAL TEST: a database that applied the original 008 ----------------------------------------------------
  it('A) a database that applied the ORIGINAL migration 008 upgrades to 009: 008 and its rows are unchanged, new revisions use the V2 model', async () => {
    const db = await bareDatabase();
    try {
      const pool = db.pool;
      // An existing installation: 001-007 as they are, then a row from before provenance existed (008 refuses new legacy rows, so it is written first).
      expect((await migrate(pool, loadMigrations().filter((m) => m.version <= 7))).applied).toEqual([1, 2, 3, 4, 5, 6, 7]);
      await new PostgresMarketDataStore(pool).registerSource(PRODUCTION_LIKE_SOURCE);
      const a = dailyBars(XNAS, '2026-09-25', [ROW('250')], { retrievedAt: '2026-09-25T20:02:00.000Z', source: SOURCE })[0]!;
      const b = dailyBars(XNAS, '2026-09-24', [ROW('240')], { retrievedAt: '2026-10-01T12:00:00.000Z', source: SOURCE })[0]!;
      const c = dailyBars(XNAS, '2026-08-24', [ROW('230')], { retrievedAt: '2026-10-02T09:00:00.000Z', source: SOURCE })[0]!;
      expect(barContentHash(a)).toBe(A_CONTENT);
      expect(barContentHash(b)).toBe(B_CONTENT);
      await putLegacy(pool, c, 1);

      // Then 008 exactly as released in de4c3f4.
      expect((await migrate(pool, [...loadMigrations().filter((m) => m.version <= 7), originalMigration008()])).applied).toEqual([8]);
      expect(await checksumOf(pool, 8)).toBe(CHECKSUM_008);

      // Rows as the original release wrote them: a captured revision and a backfill.
      await putOriginal(pool, a, 2, 'captured_by_nexus', a.retrievedAt, A_V1, A_CONTENT);
      await putOriginal(pool, b, 3, 'historical_bar_reconstruction', null, B_V1, B_CONTENT);
      const before = await snapshot(pool);
      expect(before).toHaveLength(3);

      // The upgrade: the current migrator, on the same database (no recreation).
      expect(await migrate(pool, loadMigrations())).toEqual({ applied: [9], alreadyApplied: [1, 2, 3, 4, 5, 6, 7, 8] });
      expect(await checksumOf(pool, 8)).toBe(CHECKSUM_008);
      expect(await checksumOf(pool, 9)).toBe(CHECKSUM_009);
      expect(await migrate(pool, loadMigrations())).toEqual({ applied: [], alreadyApplied: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
      expect(await snapshot(pool)).toEqual(before);
      expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM market_bars WHERE knowledge_source_v2 IS NOT NULL')).rows[0]!.n).toBe(0);

      // Old rows: their 008 meaning holds, their hashes verify, and nothing is invented for the V2 model.
      const reader = new PostgresMarketDataStore(pool);
      const research = await reader.readBars({ ...SERIES, asOf: '2026-10-10T00:00:00.000Z', replay: 'historical_research' });
      expect(research.map((x) => x.startTime)).toEqual([c.startTime, b.startTime, a.startTime]);
      expect(research.map((x) => x.knowledge.knowledgeSource)).toEqual(['legacy_unproven', 'legacy_unproven', 'legacy_unproven']);
      expect(research.every((x) => x.knowledgeVintageHash === null)).toBe(true);
      expect(await reader.readBars({ ...SERIES, asOf: '2026-10-10T00:00:00.000Z', replay: 'historical_research' })).toEqual(research);
      await expect(reader.readBars({ ...SERIES, asOf: '2026-10-10T00:00:00.000Z', replay: 'decision_time' })).rejects.toMatchObject({ code: 'BAR_KNOWLEDGE_NOT_PROVEN' });

      // New revisions after 009: the V2 model, mirrored into 008 for the compatibility of the same columns.
      const dNew = captured(dailyBars(XNAS, '2026-09-23', [ROW('245')], { retrievedAt: '2026-09-23T20:03:00.000Z', source: SOURCE })[0]!, '2026-09-23T20:03:00.000Z');
      const ingestedNew = await reader.ingestBars(AAPL, [dNew], dNew.retrievedAt);
      expect(ingestedNew).toMatchObject({ inserted: 1, quarantined: [] });
      // Revision 2 of a bar that was legacy: NEXUS holds it from its retrieval. A later revision cannot be known before the earlier one.
      const a2 = captured(dailyBars(XNAS, '2026-09-25', [ROW('251')], { retrievedAt: '2026-10-09T12:00:00.000Z', source: SOURCE })[0]!, '2026-10-09T12:00:00.000Z');
      expect(await reader.ingestBars(AAPL, [a2], a2.retrievedAt)).toMatchObject({ inserted: 1, quarantined: [] });

      const range = { from: '2026-09-25T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' };
      const afterUpgrade = await reader.readBars({ ...SERIES, ...range, asOf: '2026-10-09T12:30:00.000Z', replay: 'decision_time' });
      expect(afterUpgrade.map((x) => [x.revision, x.knowledge.knownAt, x.knowledge.vintage])).toEqual([[2, '2026-10-09T12:00:00.000Z', 'historical_reconstruction']]);
      // Before NEXUS held revision 2, the legacy revision 1 is refused as a whole: nothing is substituted.
      await expect(reader.readBars({ ...SERIES, ...range, asOf: '2026-10-09T11:00:00.000Z', replay: 'decision_time' })).rejects.toMatchObject({ code: 'BAR_KNOWLEDGE_NOT_PROVEN' });
      const newDay = await reader.readBars({ ...SERIES, from: '2026-09-23T00:00:00.000Z', to: '2026-09-24T00:00:00.000Z', asOf: '2026-09-24T00:00:00.000Z', replay: 'decision_time' });
      expect(newDay.map((x) => [x.startTime, x.knowledge.knownAt, x.knowledge.vintage])).toEqual([[dNew.startTime, '2026-09-23T20:03:00.000Z', 'contemporaneous']]);

      // The V2 floor of a revision that follows a legacy one: a later revision cannot be known before the earlier one (knowledge moves forward).
      await expect(
        putRawBar(pool, { instrument: AAPL.instrumentId, source: SOURCE, start: a.startTime, end: a.endTime, revision: 3, observed: a.observedAt, available: '2026-10-09T12:00:00.000Z', retrieved: '2026-10-05T00:00:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-10-05T00:00:00.000Z', vintage: 'historical_reconstruction', policy: BAR_VINTAGE_POLICY_VERSION } }),
      ).rejects.toThrow(/knowledge moves forward only/);
      expect((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM market_bars WHERE start_time = $1', [a.startTime])).rows[0]!.n).toBe(2);
    } finally {
      await db.drop();
    }
  });

  // ---- B) a fresh database: 001-009, and every path works ----------------------------------------------------------------
  it('B) a fresh database runs 001-009, and the store writes and reads both models with the 008 mirror', async () => {
    const db: TestDatabase = await createTestDatabase();
    try {
      const versions = (await db.pool.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(await checksumOf(db.pool, 8)).toBe(CHECKSUM_008);
      expect(await checksumOf(db.pool, 9)).toBe(CHECKSUM_009);

      const store = new PostgresMarketDataStore(db.pool);
      await store.registerSource(PRODUCTION_LIKE_SOURCE);
      const live = captured(dailyBars(XNAS, '2026-09-25', [ROW('251')], { retrievedAt: '2026-09-25T20:02:00.000Z', source: SOURCE })[0]!, '2026-09-25T20:02:00.000Z');
      const backfill = captured(dailyBars(XNAS, '2026-09-24', [ROW('250')], { retrievedAt: '2026-10-09T12:00:00.000Z', source: SOURCE })[0]!, '2026-10-09T12:00:00.000Z');
      expect(await store.ingestBars(AAPL, [backfill, live], '2026-10-09T12:00:00.000Z')).toMatchObject({ inserted: 2, quarantined: [] });

      // Coexistence: the 008 columns mirror the V2 knowledge.
      const rows = (await db.pool.query(
        'SELECT start_time, knowledge_provenance, revision_known_at, knowledge_source_v2, known_at_v2, vintage_v2 FROM market_bars ORDER BY start_time',
      )).rows;
      expect(rows.map((r) => [r.knowledge_provenance, r.revision_known_at?.toISOString() ?? null, r.knowledge_source_v2, r.known_at_v2?.toISOString() ?? null, r.vintage_v2])).toEqual([
        ['historical_bar_reconstruction', null, 'captured_by_nexus', '2026-10-09T12:00:00.000Z', 'historical_reconstruction'],
        ['captured_by_nexus', '2026-09-25T20:02:00.000Z', 'captured_by_nexus', '2026-09-25T20:02:00.000Z', 'contemporaneous'],
      ]);

      const reader = new PostgresMarketDataStore(db.extraPool());
      const decision = await reader.readBars({ ...SERIES, asOf: '2026-10-09T12:30:00.000Z', replay: 'decision_time' });
      expect(decision.map((x) => [x.knowledge.knownAt, x.knowledge.vintage, x.knowledge.vintagePolicy, typeof x.knowledgeVintageHash])).toEqual([
        ['2026-10-09T12:00:00.000Z', 'historical_reconstruction', BAR_VINTAGE_POLICY_VERSION, 'string'],
        ['2026-09-25T20:02:00.000Z', 'contemporaneous', BAR_VINTAGE_POLICY_VERSION, 'string'],
      ]);
      expect(await reader.readBars({ ...SERIES, asOf: '2026-10-09T12:30:00.000Z', replay: 'historical_research' })).toHaveLength(2);
    } finally {
      await db.drop();
    }
  });

  // ---- C) the V2 fields: the combinations the database accepts and refuses -----------------------------------------------
  describe('C) the database accepts only the knowledge and vintage combinations the model allows', () => {
    let db: TestDatabase;
    let n = 0;
    beforeAll(async () => {
      db = await createTestDatabase();
      await new PostgresMarketDataStore(db.pool).registerSource(PRODUCTION_LIKE_SOURCE);
    });
    afterAll(async () => {
      await db?.drop();
    });
    /** Each case uses its own instrument, so sequences and revisions never interact. */
    const next = () => 'ins_case_' + ++n;
    const SRC = SOURCE;
    const day = (instrument: string, extra: Partial<RawBar> = {}): RawBar => ({
      instrument,
      source: SRC,
      start: '2026-09-25T04:00:00.000Z',
      end: '2026-09-26T04:00:00.000Z',
      observed: '2026-09-25T20:00:00.000Z',
      available: '2026-09-25T20:00:00.000Z',
      retrieved: '2026-09-25T20:30:00.000Z',
      ...extra,
    });
    const CONTEMP = { vintage: 'contemporaneous', policy: BAR_VINTAGE_POLICY_VERSION };

    it('accepts a captured contemporaneous revision, a provider publication, and a backfill', async () => {
      await expect(putRawBar(db.pool, day(next(), { v2: { source: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z', ...CONTEMP } }))).resolves.toBeUndefined();
      await expect(putRawBar(db.pool, day(next(), { v2: { source: 'provider_published_at', known: '2026-09-25T20:10:00.000Z', ...CONTEMP } }))).resolves.toBeUndefined();
      await expect(
        putRawBar(db.pool, day(next(), { retrieved: '2026-10-09T12:00:00.000Z', available: '2026-10-09T12:00:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-10-09T12:00:00.000Z', vintage: 'historical_reconstruction', policy: BAR_VINTAGE_POLICY_VERSION } })),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['a captured revision is known exactly at its retrieval', { v2: { source: 'captured_by_nexus', known: '2026-09-25T20:20:00.000Z', ...CONTEMP } }, /market_bars_(captured_is_retrieval|known_at_v2_shape)/],
      ['a provider publication is not later than the retrieval', { v2: { source: 'provider_published_at', known: '2026-09-25T20:40:00.000Z', ...CONTEMP } }, /market_bars_(knowledge_shape|known_at_v2_shape)/],
      ['a known source needs its time', { v2: { source: 'provider_published_at', known: null, ...CONTEMP } }, /market_bars_(v2_complete|known_at_v2_shape|provenance_required|v2_required)/],
      ['the V2 fields are all present or all absent', { v2: { source: null, known: null, vintage: 'contemporaneous', policy: BAR_VINTAGE_POLICY_VERSION, hash: null }, v1: { provenance: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z' } }, /market_bars_(v2_complete|v2_required)/],
      ['legacy is not a stored source', { v2: { source: 'legacy_unproven', known: '2026-09-25T20:30:00.000Z', ...CONTEMP }, v1: { provenance: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z' } }, /market_bars_(knowledge_source_v2_values|known_at_v2_shape)/],
      ['the vintage must be one of the two proven values', { v2: { source: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z', vintage: 'guessed', policy: BAR_VINTAGE_POLICY_VERSION } }, /market_bars_(vintage_v2_values|v1_mirrors_v2)/],
      ['the policy is a versioned id', { v2: { source: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z', vintage: 'contemporaneous', policy: 'bar vintage' } }, /market_bars_vintage_policy_v2_format/],
      ['the hash has its format', { v2: { source: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z', ...CONTEMP, hash: 'XYZ' } }, /market_bars_knowledge_vintage_hash_format/],
      ['a final bar is not known before its completion', { retrieved: '2026-09-25T19:50:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-09-25T19:50:00.000Z', ...CONTEMP } }, /not_before_completion/],
      ['the vintage follows the window: inside it is contemporaneous (not a reconstruction)', { v2: { source: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z', vintage: 'historical_reconstruction', policy: BAR_VINTAGE_POLICY_VERSION } }, /market_bars_vintage_v2_window/],
      ['the vintage follows the window: beyond it is not contemporaneous', { retrieved: '2026-09-25T22:01:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-09-25T22:01:00.000Z', ...CONTEMP } }, /market_bars_vintage_v2_window/],
      ['the 008 mirror must be the mirror of the V2 knowledge', { v2: { source: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z', ...CONTEMP }, v1: { provenance: 'historical_bar_reconstruction', known: null } }, /market_bars_v1_mirrors_v2/],
      ['a new row must state the V2 model', { v2: null, v1: { provenance: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z' } }, /market_bars_v2_required/],
    ] as Array<[string, Partial<RawBar>, RegExp]>)('refuses: %s', async (_name, extra, expected) => {
      await expect(putRawBar(db.pool, day(next(), extra))).rejects.toThrow(expected);
    });
  });

  // ---- D) the trigger: sequence, final, knowledge that moves forward, no leakage -----------------------------------------
  describe('D) the revision trigger keeps its rules and states the V2 floor', () => {
    let db: TestDatabase;
    let n = 0;
    beforeAll(async () => {
      db = await createTestDatabase();
      await new PostgresMarketDataStore(db.pool).registerSource(PRODUCTION_LIKE_SOURCE);
    });
    afterAll(async () => {
      await db?.drop();
    });
    const next = () => 'ins_trig_' + ++n;
    const base = (instrument: string, extra: Partial<RawBar>): RawBar => ({
      instrument,
      source: SOURCE,
      start: '2026-09-25T04:00:00.000Z',
      end: '2026-09-26T04:00:00.000Z',
      observed: '2026-09-25T20:00:00.000Z',
      available: '2026-09-25T20:00:00.000Z',
      retrieved: '2026-09-25T20:30:00.000Z',
      v2: { source: 'captured_by_nexus', known: '2026-09-25T20:30:00.000Z', vintage: 'contemporaneous', policy: BAR_VINTAGE_POLICY_VERSION },
      ...extra,
    });

    it('a bar starts at revision 1 and each revision follows the one before', async () => {
      const i = next();
      await expect(putRawBar(db.pool, base(i, { revision: 2 }))).rejects.toThrow(/first revision of a bar must be 1/);
      await putRawBar(db.pool, base(i, { revision: 1 }));
      await expect(putRawBar(db.pool, base(i, { revision: 3, retrieved: '2026-09-25T21:00:00.000Z', available: '2026-09-25T21:00:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-09-25T21:00:00.000Z', vintage: 'contemporaneous', policy: BAR_VINTAGE_POLICY_VERSION } }))).rejects.toThrow(/bar revision must be 2/);
    });

    it('a final bar cannot be replaced by an in-progress bar', async () => {
      const i = next();
      await putRawBar(db.pool, base(i, {}));
      await expect(putRawBar(db.pool, base(i, { revision: 2, isFinal: false, retrieved: '2026-09-25T21:00:00.000Z', available: '2026-09-25T21:00:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-09-25T21:00:00.000Z', vintage: 'contemporaneous', policy: BAR_VINTAGE_POLICY_VERSION } }))).rejects.toThrow(/a final bar cannot be replaced by an in-progress bar/);
    });

    it('knowledge moves forward only (V2): a later revision cannot be known before the floor of the earlier one', async () => {
      const i = next();
      // Revision 1: a backfill, known from its retrieval on 2026-10-01 (its vintage is a reconstruction).
      await putRawBar(db.pool, base(i, { retrieved: '2026-10-01T12:00:00.000Z', available: '2026-09-25T20:00:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-10-01T12:00:00.000Z', vintage: 'historical_reconstruction', policy: BAR_VINTAGE_POLICY_VERSION } }));
      // Revision 2 claims to be known on 2026-09-30, before revision 1 was known. Its gate is raised to that moment, so only the knowledge rule can refuse it.
      await expect(
        putRawBar(db.pool, base(i, { revision: 2, retrieved: '2026-09-30T10:00:00.000Z', available: '2026-09-30T10:00:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-09-30T10:00:00.000Z', vintage: 'historical_reconstruction', policy: BAR_VINTAGE_POLICY_VERSION } })),
      ).rejects.toThrow(/knowledge moves forward only/);
    });

    it('no leakage: a revision is not visible before NEXUS knew it', async () => {
      const i = next();
      await putRawBar(db.pool, base(i, {}));
      await expect(
        putRawBar(db.pool, base(i, { revision: 2, retrieved: '2026-09-25T21:00:00.000Z', available: '2026-09-25T20:45:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-09-25T21:00:00.000Z', vintage: 'contemporaneous', policy: BAR_VINTAGE_POLICY_VERSION } })),
      ).rejects.toThrow(/cannot become available before it was retrieved or known/);
    });

    it('a later revision that keeps the rules is accepted', async () => {
      const i = next();
      await putRawBar(db.pool, base(i, {}));
      await expect(putRawBar(db.pool, base(i, { revision: 2, retrieved: '2026-09-25T21:00:00.000Z', available: '2026-09-25T21:00:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-09-25T21:00:00.000Z', vintage: 'contemporaneous', policy: BAR_VINTAGE_POLICY_VERSION } }))).resolves.toBeUndefined();
    });

    it('a privileged change of the 008 mirror is still refused by the database (CHECK constraints are never bypassed)', async () => {
      const i = next();
      await putRawBar(db.pool, base(i, {}));
      const privileged = await db.privilegedClient();
      try {
        await privileged.query("SET session_replication_role = 'replica'");
        await expect(privileged.query("UPDATE market_bars SET knowledge_provenance = 'historical_bar_reconstruction', revision_known_at = NULL WHERE instrument_id = $1", [i])).rejects.toThrow(/market_bars_v1_mirrors_v2/);
      } finally {
        await privileged.end();
      }
    });
  });

  // ---- E) the capture window: the actual completion of the calendar, boundary inclusive, decides the vintage only ---------
  it('E) capture window (bar-vintage:v1): the store and the database agree on the boundary, for the real completion of each calendar day', async () => {
    const db = await createTestDatabase();
    try {
      const store = new PostgresMarketDataStore(db.pool);
      await store.registerSource(PRODUCTION_LIKE_SOURCE);
      // July (EDT): completion 20:00 UTC, so 22:00 qualifies and 22:01 does not. January (EST): completion 21:00 UTC, the boundary moves.
      const cases = [
        { date: '2026-07-08', completion: '2026-07-08T20:00:00.000Z', retrieved: '2026-07-08T22:00:00.000Z', vintage: 'contemporaneous' },
        { date: '2026-07-09', completion: '2026-07-09T20:00:00.000Z', retrieved: '2026-07-09T22:01:00.000Z', vintage: 'historical_reconstruction' },
        { date: '2026-01-12', completion: '2026-01-12T21:00:00.000Z', retrieved: '2026-01-12T23:00:00.000Z', vintage: 'contemporaneous' },
        { date: '2026-01-13', completion: '2026-01-13T21:00:00.000Z', retrieved: '2026-01-13T23:01:00.000Z', vintage: 'historical_reconstruction' },
      ] as const;
      for (const c of cases) {
        const raw = dailyBars(XNAS, c.date, [ROW('250')], { retrievedAt: c.retrieved, source: SOURCE })[0]!;
        expect(raw.observedAt, c.date + ' completion from the calendar').toBe(c.completion);
        const bar = captured(raw, c.retrieved);
        expect(bar.knowledge.vintage, c.date).toBe(c.vintage);
        expect(await store.ingestBars(AAPL, [bar], c.retrieved), c.date).toMatchObject({ inserted: 1, quarantined: [] });
        const stored = (await db.pool.query<{ vintage_v2: string }>('SELECT vintage_v2 FROM market_bars WHERE start_time = $1', [raw.startTime])).rows[0]!;
        expect(stored.vintage_v2, c.date + ' stored').toBe(c.vintage);
      }
      // The database refuses a label that contradicts the window, whatever the store would have said.
      await expect(
        putRawBar(db.pool, { instrument: 'ins_win_jul', source: SOURCE, start: '2026-07-08T04:00:00.000Z', end: '2026-07-09T04:00:00.000Z', observed: '2026-07-08T20:00:00.000Z', available: '2026-07-08T20:00:00.000Z', retrieved: '2026-07-08T22:01:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-07-08T22:01:00.000Z', vintage: 'contemporaneous', policy: BAR_VINTAGE_POLICY_VERSION } }),
      ).rejects.toThrow(/market_bars_vintage_v2_window/);
      await expect(
        putRawBar(db.pool, { instrument: 'ins_win_jan', source: SOURCE, start: '2026-01-12T05:00:00.000Z', end: '2026-01-13T05:00:00.000Z', observed: '2026-01-12T21:00:00.000Z', available: '2026-01-12T21:00:00.000Z', retrieved: '2026-01-12T23:00:00.000Z', v2: { source: 'captured_by_nexus', known: '2026-01-12T23:00:00.000Z', vintage: 'historical_reconstruction', policy: BAR_VINTAGE_POLICY_VERSION } }),
      ).rejects.toThrow(/market_bars_vintage_v2_window/);
    } finally {
      await db.drop();
    }
  });

  it('E) capture window, intraday (15 minutes, inclusive): the database enforces the boundary to the millisecond', async () => {
    const db = await createTestDatabase();
    try {
      await new PostgresMarketDataStore(db.pool).registerSource(PRODUCTION_LIKE_SOURCE);
      const bar = (instrument: string, start: string, end: string, retrieved: string, vintage: string): RawBar => ({
        instrument,
        source: SOURCE,
        interval: '15m',
        start,
        end,
        observed: end,
        available: end,
        retrieved,
        v2: { source: 'captured_by_nexus', known: retrieved, vintage, policy: BAR_VINTAGE_POLICY_VERSION },
      });
      // A 15-minute bar completes at its end. Retrieved exactly 15 minutes later: contemporaneous. One millisecond later: not.
      await expect(putRawBar(db.pool, bar('ins_15m', '2026-09-25T13:30:00.000Z', '2026-09-25T13:45:00.000Z', '2026-09-25T14:00:00.000Z', 'contemporaneous'))).resolves.toBeUndefined();
      await expect(putRawBar(db.pool, bar('ins_15m_late', '2026-09-25T13:30:00.000Z', '2026-09-25T13:45:00.000Z', '2026-09-25T14:00:00.001Z', 'contemporaneous'))).rejects.toThrow(/market_bars_vintage_v2_window/);
      await expect(putRawBar(db.pool, bar('ins_15m_late', '2026-09-25T13:30:00.000Z', '2026-09-25T13:45:00.000Z', '2026-09-25T14:00:00.001Z', 'historical_reconstruction'))).resolves.toBeUndefined();
    } finally {
      await db.drop();
    }
  });
});
