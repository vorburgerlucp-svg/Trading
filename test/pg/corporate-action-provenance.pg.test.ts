import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { corporateActionContentHash } from '../../src/market-data/bar-validation.js';
import { splitAdjustBars } from '../../src/market-data/corporate-actions.js';
import { MarketDataIntegrityError } from '../../src/market-data/market-data-store.js';
import type { CorporateAction } from '../../src/market-data/market-data-types.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { Decimal } from '../../src/money/decimal.js';
import { loadMigrations, migrate } from '../../src/persistence/postgres/migrator.js';
import { createPool } from '../../src/persistence/postgres/pool.js';
import { PostgresMarketDataStore } from '../../src/persistence/postgres/postgres-market-data-store.js';
import { AAPL, FIXTURE_SOURCE, dailyBars } from '../market-data/fixtures.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

const XNAS = getCalendar('XNAS')!;
const DAILY = { instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, interval: '1d' as const, session: 'regular' as const, adjustment: 'raw' as const };
const FRI = '2026-09-25T10:00:00.000Z';
const TUE_PUBLISHED = '2026-09-29T09:00:00.000Z';
const TUE_NOON = '2026-09-29T12:00:00.000Z';
const WED = '2026-09-30T12:00:00.000Z';
const THU = '2026-10-01T10:00:00.000Z';
const ROWS = ['400', '404', '408', '101', '102', '103'].map((p) => ({ open: p, high: p, low: p, close: p, volume: '1000' }));
const HASH_PLACEHOLDER = 'a'.repeat(64);

const captured = (at: string) => ({ provenance: 'captured_by_nexus' as const, knowledgeAt: at });
/** A 4-for-1 split on Monday 2026-09-28, first retrieved at `retrievedAt`. */
function split(retrievedAt: string, over: Partial<CorporateAction> = {}): CorporateAction {
  return { actionKey: 'split:2026-09-28', instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, type: 'split', exDate: '2026-09-28', ratioFrom: Decimal.from(1), ratioTo: Decimal.from(4), retrievedAt, knowledge: captured(retrievedAt), ...over };
}

describe.skipIf(!pgAvailable)('corporate action provenance on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  let db: TestDatabase | null = null;
  afterEach(async () => {
    await db?.drop();
    db = null;
  });

  // Review finding F3 (HIGH): migration 004's comment says a new revision is never visible before it was retrieved. Its trigger
  // only checked available_at >= retrieved_at for revisions >= 2, so a first revision could be stored before its retrieval.
  // Migration 007 replaces the function body (the trigger itself is unchanged): the first revision is checked too.
  it('F3: the database refuses a first revision whose availability lies before its retrieval', async () => {
    db = await createTestDatabase();
    await new PostgresMarketDataStore(db.extraPool()).registerSource(FIXTURE_SOURCE);
    await expect(
      db.pool.query(
        `INSERT INTO corporate_actions (instrument_id, source_id, action_key, revision, type, ex_date, ratio_from, ratio_to, available_at, retrieved_at, ingest_seq, content_hash, knowledge_provenance, knowledge_at, provenance_hash)
         VALUES ('ins_aapl', $1, 'split:2020-08-31', 1, 'split', '2020-08-31', 1, 4, '2020-08-31T04:00:00.000Z', '2026-10-07T13:57:30.000Z', 1, $2, 'captured_by_nexus', '2026-10-07T13:57:30.000Z', $2)`,
        [FIXTURE_SOURCE.sourceId, HASH_PLACEHOLDER],
      ),
    ).rejects.toThrow(/cannot be available before it was retrieved/);
  });

  it('every new row states its knowledge provenance and its provenance hash (NOT VALID applies to new rows)', async () => {
    db = await createTestDatabase();
    await new PostgresMarketDataStore(db.extraPool()).registerSource(FIXTURE_SOURCE);
    await expect(
      db.pool.query(
        `INSERT INTO corporate_actions (instrument_id, source_id, action_key, revision, type, ex_date, ratio_from, ratio_to, available_at, retrieved_at, ingest_seq, content_hash)
         VALUES ('ins_aapl', $1, 'split:2026-09-28', 1, 'split', '2026-09-28', 1, 4, $2, $2, 1, $3)`,
        [FIXTURE_SOURCE.sourceId, FRI, HASH_PLACEHOLDER],
      ),
    ).rejects.toThrow(/corporate_actions_provenance_required/);
  });

  it('a captured record cannot carry a knowledge time other than its retrieval', async () => {
    db = await createTestDatabase();
    await new PostgresMarketDataStore(db.extraPool()).registerSource(FIXTURE_SOURCE);
    await expect(
      db.pool.query(
        `INSERT INTO corporate_actions (instrument_id, source_id, action_key, revision, type, ex_date, ratio_from, ratio_to, available_at, retrieved_at, ingest_seq, content_hash, knowledge_provenance, knowledge_at, provenance_hash)
         VALUES ('ins_aapl', $1, 'split:2026-09-28', 1, 'split', '2026-09-28', 1, 4, $2, $2, 1, $3, 'captured_by_nexus', '2026-09-20T00:00:00.000Z', $3)`,
        [FIXTURE_SOURCE.sourceId, FRI, HASH_PLACEHOLDER],
      ),
    ).rejects.toThrow(/corporate_actions_captured_is_retrieval/);
  });

  it('roundtrip: knowledge, provenance hash, revisions and the replay rule survive a fresh process', async () => {
    db = await createTestDatabase();
    const writer = new PostgresMarketDataStore(db.pool);
    await writer.registerSource(FIXTURE_SOURCE);
    await writer.ingestBars(AAPL, dailyBars(XNAS, '2026-09-23', ROWS), '2026-10-01T00:00:00Z');
    await writer.ingestCorporateActions(AAPL, [split(FRI)], FRI); // revision 1: captured on Friday
    await writer.ingestCorporateActions(AAPL, [split(WED, { ratioTo: Decimal.from(5) })], WED); // revision 2: a correction, captured on Wednesday
    await writer.ingestCorporateActions(AAPL, [split(WED, { actionKey: 'split:2026-10-02:rev', exDate: '2026-10-02', type: 'reverse_split', ratioFrom: Decimal.from(10), ratioTo: Decimal.from(1), knowledge: { provenance: 'provider_published_at', knowledgeAt: TUE_PUBLISHED } })], WED);

    const reader = new PostgresMarketDataStore(db.extraPool());
    const tue = await reader.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: TUE_NOON, purpose: 'information' });
    // revision 2 is not visible on Tuesday; the reverse split is visible from its publication time (Tuesday 09:00)
    expect(tue.map((a) => [a.actionKey, a.revision, a.ratioTo!.toString(), a.knowledge, a.storedAvailableAt, a.provenanceHash?.length])).toEqual([
      ['split:2026-09-28', 1, '4', captured(FRI), FRI, 64],
      ['split:2026-10-02:rev', 1, '1', { provenance: 'provider_published_at', knowledgeAt: TUE_PUBLISHED }, WED, 64],
    ]);
    const thu = await reader.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: THU, purpose: 'information' });
    const revised = thu.find((a) => a.actionKey === 'split:2026-09-28');
    expect([revised!.revision, revised!.ratioTo!.toString()]).toEqual([2, '5']);

    // the series a fresh process derives on Tuesday: revision 1 applied to the bars before the ex-date
    const series = splitAdjustBars(await reader.readBars({ ...DAILY, asOf: TUE_NOON }), tue, { asOf: TUE_NOON, calendar: XNAS, purpose: 'information' });
    expect(series.status === 'ok' && series.bars.map((b) => b.close.toString())).toEqual(['100', '101', '102', '101']);
  });

  it('a publication time makes knowledge visible from that time, not from the capture', async () => {
    db = await createTestDatabase();
    const writer = new PostgresMarketDataStore(db.pool);
    await writer.registerSource(FIXTURE_SOURCE);
    await writer.ingestCorporateActions(AAPL, [split(WED, { knowledge: { provenance: 'provider_published_at', knowledgeAt: TUE_PUBLISHED } })], WED);
    const reader = new PostgresMarketDataStore(db.extraPool());
    expect(await reader.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: '2026-09-29T08:00:00.000Z' })).toEqual([]);
    expect((await reader.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: '2026-09-29T10:00:00.000Z' })).map((a) => a.knowledge.knowledgeAt)).toEqual([TUE_PUBLISHED]);
  });

  it('a privileged change of a stored knowledge time is detected on read (fail closed)', async () => {
    db = await createTestDatabase();
    const writer = new PostgresMarketDataStore(db.pool);
    await writer.registerSource(FIXTURE_SOURCE);
    await writer.ingestCorporateActions(AAPL, [split(WED, { knowledge: { provenance: 'provider_published_at', knowledgeAt: TUE_PUBLISHED } })], WED);
    const privileged = await db.privilegedClient();
    try {
      await privileged.query("SET session_replication_role = 'replica'"); // disables triggers: a superuser bypassing NEXUS
      // Moves the knowledge time earlier, to a value that still passes every CHECK constraint.
      await privileged.query("UPDATE corporate_actions SET knowledge_at = '2026-09-28T09:00:00.000Z' WHERE action_key = 'split:2026-09-28'");
    } finally {
      await privileged.end();
    }
    await expect(new PostgresMarketDataStore(db.extraPool()).readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: WED })).rejects.toBeInstanceOf(MarketDataIntegrityError);
  });

  // Migration 007 on a database that already holds rows written under 004. The schema is built with migrations 001-006, the
  // legacy row is written the way the previous code wrote it (available_at = min(retrievedAt, exDate)), then 007 is applied.
  it('migration 007 on existing data: legacy rows are not rewritten and carry no invented knowledge time', async () => {
    if (!pgInfo.available) throw new Error('PostgreSQL not available: ' + pgInfo.reason);
    const { connection, adminDatabase } = pgInfo;
    const name = 'nexus_t_mig_' + randomBytes(6).toString('hex');
    const admin = new pg.Client({ ...connection, database: adminDatabase });
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query('CREATE DATABASE ' + name);
    await admin.end();
    const pool = createPool({ ...connection, database: name, max: 2, applicationName: 'nexus-test' });
    const AT = '2026-10-08T00:00:00.000Z';
    try {
      await migrate(pool, loadMigrations().filter((m) => m.version <= 6));
      const before = new PostgresMarketDataStore(pool);
      await before.registerSource(FIXTURE_SOURCE);
      const legacy: CorporateAction = { actionKey: 'split:2020-08-31', instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, type: 'split', exDate: '2020-08-31', ratioFrom: Decimal.from(1), ratioTo: Decimal.from(4), retrievedAt: '2026-10-07T13:57:30.000Z', knowledge: { provenance: 'legacy_unproven', knowledgeAt: null } };
      await pool.query(
        `INSERT INTO corporate_actions (instrument_id, source_id, action_key, revision, type, ex_date, ratio_from, ratio_to, available_at, retrieved_at, ingest_seq, content_hash)
         VALUES ($1, $2, 'split:2020-08-31', 1, 'split', '2020-08-31', 1, 4, '2020-08-31T04:00:00.000Z', '2026-10-07T13:57:30.000Z', 1, $3)`,
        [AAPL.instrumentId, FIXTURE_SOURCE.sourceId, corporateActionContentHash(legacy)],
      );

      const applied = await migrate(pool, loadMigrations());
      // Bars are written by the current store, after the schema that holds their columns exists.
      await new PostgresMarketDataStore(pool).ingestBars(AAPL, dailyBars(XNAS, '2020-08-27', ROWS.slice(0, 2)), '2026-10-08T00:00:00Z');
      expect(applied.applied).toEqual([7, 8, 9]);

      const row = (await pool.query("SELECT available_at, retrieved_at, knowledge_provenance, knowledge_at, provenance_hash FROM corporate_actions WHERE action_key = 'split:2020-08-31'")).rows[0];
      expect(row).toEqual({ available_at: new Date('2020-08-31T04:00:00.000Z'), retrieved_at: new Date('2026-10-07T13:57:30.000Z'), knowledge_provenance: null, knowledge_at: null, provenance_hash: null });

      const store = new PostgresMarketDataStore(pool);
      // the old availability is not knowledge: nothing is visible before NEXUS retrieved the record
      expect(await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: '2026-09-28T12:00:00.000Z' })).toEqual([]);
      const [seen] = await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: AT });
      expect(seen!.knowledge).toEqual({ provenance: 'legacy_unproven', knowledgeAt: null });
      expect(seen!.provenanceHash).toBeNull();
      // information fails closed on it, with the reason; the economic reconstruction applies it and labels it
      const raw = await store.readBars({ ...DAILY, asOf: AT });
      expect(splitAdjustBars(raw, [seen!], { asOf: AT, calendar: XNAS, purpose: 'information' })).toMatchObject({ status: 'CORPORATE_ACTION_TIMING_UNPROVEN', unproven: [{ actionKey: 'split:2020-08-31', provenance: 'legacy_unproven', knowledgeAt: null }] });
      const economic = splitAdjustBars(raw, await store.readCorporateActions({ instrumentId: AAPL.instrumentId, asOf: AT, purpose: 'economic' }), { asOf: AT, calendar: XNAS, purpose: 'economic' });
      expect(economic.status === 'ok' && economic.unprovenApplied.map((a) => a.provenance)).toEqual(['legacy_unproven']);

      // the first-revision check is in force for new writes, and new rows must state their provenance
      await expect(
        pool.query(
          `INSERT INTO corporate_actions (instrument_id, source_id, action_key, revision, type, ex_date, ratio_from, ratio_to, available_at, retrieved_at, ingest_seq, content_hash)
           VALUES ($1, $2, 'split:2026-09-28:new', 1, 'split', '2026-09-28', 1, 4, '2026-09-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z', 4, $3)`,
          [AAPL.instrumentId, FIXTURE_SOURCE.sourceId, HASH_PLACEHOLDER],
        ),
      ).rejects.toThrow(/cannot be available before it was retrieved/);
      await expect(
        pool.query(
          `INSERT INTO corporate_actions (instrument_id, source_id, action_key, revision, type, ex_date, ratio_from, ratio_to, available_at, retrieved_at, ingest_seq, content_hash)
           VALUES ($1, $2, 'split:2026-09-28:new', 1, 'split', '2026-09-28', 1, 4, $3, $3, 4, $4)`,
          [AAPL.instrumentId, FIXTURE_SOURCE.sourceId, WED, HASH_PLACEHOLDER],
        ),
      ).rejects.toThrow(/corporate_actions_provenance_required/);
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
