// Market data and quant persistence against a real PostgreSQL: the shared contract suite, the
// database's own refusals, restart/replay of a quant run, and tamper detection.

import { afterEach, describe, expect, it } from 'vitest';
import { InstrumentRegistry } from '../../src/market-data/instrument-registry.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { verifyMigrations } from '../../src/persistence/postgres/migrator.js';
import { instrumentProjector } from '../../src/persistence/postgres/market-data-projectors.js';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { PostgresMarketDataStore } from '../../src/persistence/postgres/postgres-market-data-store.js';
import { PostgresQuantRunStore } from '../../src/persistence/postgres/postgres-quant-run-store.js';
import { QuantService } from '../../src/quant/quant-service.js';
import { marketDataStoreContract } from '../contracts/market-data-store.contract.js';
import { AAPL, FIXTURE_SOURCE, dailyBars, intradayBars, randomOhlcv } from '../market-data/fixtures.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

const XNAS = getCalendar('XNAS')!;
const HUMAN = { kind: 'human' as const, id: 'luc' };

describe.skipIf(!pgAvailable)('PostgreSQL market data' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  marketDataStoreContract('PostgresMarketDataStore', async () => {
    const db = await createTestDatabase();
    return {
      store: async () => new PostgresMarketDataStore(db.extraPool()),
      quantRuns: async () => new PostgresQuantRunStore(db.extraPool()),
      instruments: () => PostgresAppendOnlyStore.open(db.extraPool(), 'instruments', { projector: instrumentProjector }),
      tamperBar: async (instrumentId, startTime, newClose) => {
        const c = await db.privilegedClient();
        try {
          await c.query("SET session_replication_role = 'replica'"); // disables triggers: a superuser bypassing NEXUS
          await c.query('UPDATE market_bars SET close = $1, high = $1 WHERE instrument_id = $2 AND start_time = $3', [newClose, instrumentId, startTime]);
        } finally {
          await c.end();
        }
      },
      cleanup: () => db.drop(),
    };
  });

  describe('Datenbank-Invarianten und Audit', () => {
    let db: TestDatabase | null = null;
    afterEach(async () => {
      await db?.drop();
      db = null;
    });

    async function seeded() {
      db = await createTestDatabase();
      const store = new PostgresMarketDataStore(db.pool);
      await store.registerSource(FIXTURE_SOURCE);
      await store.ingestBars(AAPL, intradayBars(XNAS, '2026-10-07T13:30:00Z', '5m', randomOhlcv(5, 1)), '2026-11-07T00:00:00Z');
      return { db, store };
    }

    it('Migration 004 ist angewendet; Tabellen existieren', async () => {
      const { db } = await seeded();
      expect(await verifyMigrations(db.pool)).toEqual({ upToDate: true, pending: [] });
      const tables = (await db.pool.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.t);
      expect(tables).toEqual(expect.arrayContaining(['instruments', 'provider_instrument_mappings', 'market_bars', 'market_quotes', 'corporate_actions', 'quant_runs', 'market_data_sources', 'market_data_heads', 'market_data_quarantine', 'instrument_events']));
    });

    it('Datenbank verweigert UPDATE, DELETE, TRUNCATE auf Marktdaten-Historie und Quant-Runs', async () => {
      const { db } = await seeded();
      for (const sql of ["UPDATE market_bars SET close = 1 WHERE instrument_id = 'ins_aapl'", "DELETE FROM market_bars WHERE instrument_id = 'ins_aapl'", 'TRUNCATE market_bars', 'TRUNCATE quant_runs', 'DELETE FROM market_data_sources', "UPDATE market_data_heads SET head_seq = 0"]) {
        await expect(db.pool.query(sql), sql).rejects.toThrow(/NEXUS_(APPEND_ONLY|LEDGER|MARKET_DATA)|immutable|append-only|can only advance/i);
      }
    });

    it('Datenbank verweigert direkt eingefügte ungültige OHLC, Sequenzlücken, falsche Revisionen und Final-Regression', async () => {
      const { db } = await seeded();
      const insert = (o: Record<string, unknown>) =>
        db.pool.query(
          `INSERT INTO market_bars (instrument_id, source_id, bar_interval, session, adjustment, start_time, end_time, revision, open, high, low, close, volume, is_final, observed_at, available_at, retrieved_at, ingest_seq, content_hash)
           VALUES ('ins_aapl', $1, '5m', 'regular', 'raw', $2, $3, $4, $5, $6, $7, $8, 10, $9, $3, $10, $11, $12, repeat('a', 64))`,
          [FIXTURE_SOURCE.sourceId, o.start ?? '2026-10-07T13:55:00Z', o.end ?? '2026-10-07T14:00:00Z', o.revision ?? 1, o.open ?? '10', o.high ?? '11', o.low ?? '9', o.close ?? '10', o.final ?? true, o.available ?? '2026-10-07T14:00:00Z', o.retrieved ?? '2026-10-07T14:00:00Z', o.seq ?? 6],
        );
      await expect(insert({ high: '9.5' })).rejects.toThrow(/market_bars_ohlc/);
      await expect(insert({ seq: 8 })).rejects.toThrow(/does not follow head/);
      await expect(insert({ revision: 2 })).rejects.toThrow(/first revision/);
      await expect(insert({ available: '2026-10-07T13:58:00Z' })).rejects.toThrow(/market_bars_final_intraday/);
      // a later revision of an existing final bar that is "in progress" again
      await expect(insert({ start: '2026-10-07T13:30:00Z', end: '2026-10-07T13:35:00Z', revision: 2, final: false, available: '2026-11-08T00:00:00Z', retrieved: '2026-11-08T00:00:00Z' })).rejects.toThrow(/cannot be replaced by an in-progress/);
      // a revision visible before it was retrieved
      await expect(insert({ start: '2026-10-07T13:30:00Z', end: '2026-10-07T13:35:00Z', revision: 2, available: '2026-10-07T13:35:00Z', retrieved: '2026-11-08T00:00:00Z' })).rejects.toThrow(/before it was retrieved/);
      expect(Number((await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM market_bars")).rows[0]!.n)).toBe(5);
    });

    it('QuantRun nach Neustart reproduzierbar, auch nach späterem Backfill mit alten Zeitstempeln', async () => {
      db = await createTestDatabase();
      const instruments = await PostgresAppendOnlyStore.open(db.extraPool(), 'instruments', { projector: instrumentProjector });
      const registry = await InstrumentRegistry.open(instruments);
      await registry.register({ ...AAPL }, { at: '2026-01-01T00:00:00Z', by: HUMAN, reason: 'setup' });
      const store = new PostgresMarketDataStore(db.extraPool());
      await store.registerSource(FIXTURE_SOURCE);
      const all = dailyBars(XNAS, '2026-01-05', randomOhlcv(180, 8), { retrievedAt: '2026-10-01T00:00:00.000Z' });
      const withoutGap = all.filter((_, i) => i !== 100); // one day missing at first
      await store.ingestBars(AAPL, withoutGap, '2026-10-01T00:00:00Z');
      const service = new QuantService({ registry, store, runs: new PostgresQuantRunStore(db.extraPool()), clock: () => new Date('2026-10-02T00:00:00Z') });
      const first = await service.run({ instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, interval: '1d', session: 'regular', adjustment: 'raw', asOf: '2026-09-25T00:00:00Z', useCase: 'backtest' });
      expect(first.status).toBe('APPLIED');
      expect(first.record.result.dataQuality.issues.map((i) => i.code)).toContain('gap');
      await expect(db.pool.query('DELETE FROM quant_runs')).rejects.toThrow(/NEXUS_APPEND_ONLY|append-only|immutable/i);
      await expect(db.pool.query("UPDATE quant_runs SET insufficient_data = NOT insufficient_data")).rejects.toThrow(/NEXUS_APPEND_ONLY|append-only|immutable/i);

      // Backfill of the missing day: NEXUS first retrieved it now, so its storage time is now (no invented old availability).
      await store.ingestBars(AAPL, [all[100]!], '2026-10-03T00:00:00Z');

      // A fresh process replays the stored run: same bars (pinned by storedThrough), same result.
      const reopened = new QuantService({ registry: await InstrumentRegistry.open(await PostgresAppendOnlyStore.open(db.extraPool(), 'instruments', { projector: instrumentProjector })), store: new PostgresMarketDataStore(db.extraPool()), runs: new PostgresQuantRunStore(db.extraPool()) });
      const replay = await reopened.replay(first.record.result.quantRunId);
      expect(replay.identical).toBe(true);
      // A new run at the same asOf now sees the backfilled bar: different input, different run id.
      const second = await reopened.run({ instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, interval: '1d', session: 'regular', adjustment: 'raw', asOf: '2026-09-25T00:00:00Z', useCase: 'backtest' });
      expect(second.record.result.quantRunId).not.toBe(first.record.result.quantRunId);
      expect(second.record.result.dataQuality.issues.map((i) => i.code)).not.toContain('gap');
    });

    it('Projektion der Instrument Registry: Tabellen spiegeln den hash-verketteten Log', async () => {
      db = await createTestDatabase();
      const registry = await InstrumentRegistry.open(await PostgresAppendOnlyStore.open(db.pool, 'instruments', { projector: instrumentProjector }));
      await registry.register({ ...AAPL }, { at: '2026-01-01T00:00:00Z', by: HUMAN, reason: 'setup' });
      await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '1980-12-12T00:00:00Z' }, { at: '2026-01-01T00:00:00Z', by: HUMAN, reason: 'setup' });
      await registry.update(AAPL.instrumentId, { name: 'Apple Inc.' }, { at: '2026-02-01T00:00:00Z', by: HUMAN, reason: 'rename' });
      const row = (await db.pool.query<{ name: string; symbol: string; tick_size: string }>("SELECT name, symbol, tick_size FROM instruments WHERE instrument_id = 'ins_aapl'")).rows[0];
      expect(row).toEqual({ name: 'Apple Inc.', symbol: 'AAPL', tick_size: '0.01' });
      expect(Number((await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM instrument_events')).rows[0]!.n)).toBe(3);
      await expect(registry.update(AAPL.instrumentId, { timezone: 'Europe/Zurich' } as never, { at: '2026-03-01T00:00:00Z', by: HUMAN, reason: 'x' })).rejects.toThrow(/cannot be changed/);
    });
  });
});
