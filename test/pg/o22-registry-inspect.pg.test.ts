// O22 B4: read-only inspection of the instrument registry, and the read-only mapping dry run, on a THROWAWAY PostgreSQL. Proves
// that the inspection and the dry run write nothing at all (no record, no log row) and that the database itself refuses a write in
// their session. The ETH/USD instrument below is TEST DATA in a throwaway database, not the operator's registry.
import { afterEach, describe, expect, it } from 'vitest';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { inspectRegistry, openRegistryReadOnly, runInspect } from '../../src/market-data/registry-inspect-cli.js';
import { runMapping } from '../../src/broker/etoro/etoro-map-instrument-cli.js';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { openPostgresMarketDataStores } from '../../src/persistence/postgres/postgres-stores.js';
import { createPool, type PgPool } from '../../src/persistence/postgres/pool.js';
import { readFileSync } from 'node:fs';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

const NOW = '2026-10-18T21:00:00.000Z';
const ETH_USD = { instrumentId: 'ins_test_eth_usd', assetClass: 'crypto' as const, symbol: 'ETH/USD', name: 'Ethereum / US Dollar', currency: 'USD', timezone: 'UTC', tradingCalendar: '24x7', active: true };
const EVIDENCE = 'docs/evidence/O22_etoro_instrument_metadata_100001_2026-10-18.json';

async function counts(pool: PgPool): Promise<{ logs: number; records: number }> {
  const logs = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM append_only_logs');
  const records = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM append_only_records');
  return { logs: logs.rows[0]!.n, records: records.rows[0]!.n };
}

/** The throwaway database's URL (the same construction as o21-runtime.pg.test.ts). */
function urlOf(db: TestDatabase): string {
  if (!pgInfo.available) throw new Error(pgSkipReason);
  const { connection } = pgInfo;
  return 'postgres://' + encodeURIComponent(connection.user) + ':' + encodeURIComponent(connection.password) + '@' + connection.host + ':' + connection.port + '/' + db.name;
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 read-only registry inspection on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  it('an empty registry: nothing found, and opening it read-only creates no log row', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const before = await counts(db.pool);
    const opened = await openRegistryReadOnly({ DATABASE_URL: urlOf(db) });
    const report = inspectRegistry(opened.registry, 'ETH', NOW, 100001);
    await opened.close();
    expect(report).toMatchObject({ readOnly: true, instrumentCount: 0, matches: [], etoro: { etoroInstrumentId: 100001, resolvesTo: null } });
    expect(await counts(db.pool)).toEqual(before);
  });

  it('finds ETH/USD with its mappings and checks, and writes nothing', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const writable = await InstrumentRegistry.open((await openPostgresMarketDataStores(db.pool)).instruments);
    await writable.registerWithMapping(ETH_USD, { provider: 'twelvedata', providerSymbol: 'ETH/USD', exchange: 'Coinbase Pro', validFrom: '2026-10-01T00:00:00.000Z' }, { at: '2026-10-01T00:00:00.000Z', by: { kind: 'system', id: 'test' }, reason: 'TEST DATA' });
    const before = await counts(db.pool);
    const outcome = await runInspect({ argv: ['--symbol=ETH', '--etoro-instrument-id=100001'], now: NOW, openRegistry: () => openRegistryReadOnly({ DATABASE_URL: urlOf(db) }) });
    expect(outcome.exitCode).toBe(0);
    if (outcome.exitCode !== 0) return;
    expect(outcome.report.matches).toEqual([
      expect.objectContaining({
        instrumentId: ETH_USD.instrumentId,
        symbol: 'ETH/USD',
        assetClass: 'crypto',
        currency: 'USD',
        active: true,
        checks: { crypto: true, quotedInUsd: true, symbolIsEthUsd: true, openEtoroMapping: null, openTwelveDataMapping: 'ETH/USD @ Coinbase Pro' },
      }),
    ]);
    expect(outcome.report.etoro).toEqual({ etoroInstrumentId: 100001, resolvesTo: null });
    expect(await counts(db.pool)).toEqual(before);
  });

  it('the read-only session refuses a write at the database, and the read-only store refuses an append', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const pool = createPool({ connectionString: urlOf(db), max: 1, options: '-c default_transaction_read_only=on' });
    try {
      await expect(pool.query("INSERT INTO append_only_logs (log_name) VALUES ('o22-probe')")).rejects.toThrow(/read-only/);
      const store = PostgresAppendOnlyStore.openReadOnly<InstrumentEvent>(pool, 'instruments');
      await expect(store.writeExclusive(0, () => ({ kind: 'skip', result: null }) as never)).rejects.toThrow(/read-only store/);
    } finally {
      await pool.end();
    }
    expect((await counts(db.pool)).logs).toBe(0);
  });

  it('the mapping dry run through the read-only path plans the mapping and writes nothing at all', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const writable = await InstrumentRegistry.open((await openPostgresMarketDataStores(db.pool)).instruments);
    await writable.register(ETH_USD, { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human', id: 'test' }, reason: 'TEST DATA' });
    const before = await counts(db.pool);
    const outcome = await runMapping({
      argv: ['--instrument-id=' + ETH_USD.instrumentId, '--metadata-report=' + EVIDENCE, '--valid-from=' + NOW, '--operator=operator-1'],
      now: NOW,
      readFile: (path) => readFileSync(path),
      openRegistry: () => openRegistryReadOnly({ DATABASE_URL: urlOf(db) }),
    });
    expect(outcome).toMatchObject({ exitCode: 0, mode: 'dry_run', plan: { mapping: { instrumentId: ETH_USD.instrumentId, provider: 'etoro', providerSymbol: '100001' } } });
    expect(await counts(db.pool)).toEqual(before);
  });

  it('no DATABASE_URL: REGISTRY_UNAVAILABLE, nothing opened', async () => {
    expect(await runInspect({ argv: ['--symbol=ETH'], now: NOW, openRegistry: () => openRegistryReadOnly({}) })).toEqual({ exitCode: 1, error: 'REGISTRY_UNAVAILABLE: the database could not be read' });
  });
});
