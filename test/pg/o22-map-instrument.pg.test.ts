// O22 B4 on a real (throwaway) PostgreSQL registry, with the REAL metadata evidence file of 2026-10-18 (100001 = Crypto / ETH /
// Ethereum): the dry run plans exactly one eToro mapping and writes nothing; without an ETH/USD instrument it creates none; and an
// existing eToro mapping is never duplicated. The ETH/USD instrument below is TEST DATA in a throwaway database, not a registration.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runMapping } from '../../src/broker/etoro/etoro-map-instrument-cli.js';
import { InstrumentRegistry } from '../../src/market-data/instrument-registry.js';
import { openPostgresMarketDataStores } from '../../src/persistence/postgres/postgres-stores.js';
import type { PgPool } from '../../src/persistence/postgres/pool.js';
import { createTestDatabase, pgAvailable, pgSkipReason, type TestDatabase } from './db.js';

const EVIDENCE = 'docs/evidence/O22_etoro_instrument_metadata_100001_2026-10-18.json';
const NOW = '2026-10-18T21:00:00.000Z';
const ETH_USD = { instrumentId: 'ins_test_eth_usd', assetClass: 'crypto' as const, symbol: 'ETH/USD', name: 'Ethereum / US Dollar', currency: 'USD', timezone: 'UTC', tradingCalendar: '24x7', active: true };
const ARGS = ['--instrument-id=' + ETH_USD.instrumentId, '--metadata-report=' + EVIDENCE, '--valid-from=' + NOW, '--operator=operator-1'];

async function registryOf(pool: PgPool) {
  const stores = await openPostgresMarketDataStores(pool);
  return InstrumentRegistry.open(stores.instruments);
}

async function instrumentEvents(pool: PgPool): Promise<number> {
  const rows = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'instruments'");
  return rows.rows[0]?.n ?? 0;
}

function run(pool: PgPool, argv: string[]) {
  return runMapping({ argv, now: NOW, readFile: (path) => readFileSync(path), openRegistry: async () => ({ registry: await registryOf(pool), close: async () => undefined }) });
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 governed mapping dry run on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  it('the evidence file is the accepted report of 2026-10-18: 100001 is Crypto, ETH, Ethereum', () => {
    const report = JSON.parse(readFileSync(EVIDENCE, 'utf8')) as Record<string, any>;
    expect(report).toEqual({
      schema: 'etoro-instrument-metadata-observation:v1',
      endpoint: 'GET /api/v2/market-data/instruments?instrumentsIds=100001',
      verdict: 'accepted',
      metadata: { instrumentId: 100001, type: 'Crypto', symbol: 'ETH', displayName: 'Ethereum' },
    });
  });

  it('dry run: plans exactly the eToro mapping 100001 -> ETH/USD citing the evidence sha256, and writes nothing', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const registry = await registryOf(db.pool);
    await registry.register(ETH_USD, { at: '2026-10-18T00:00:00.000Z', by: { kind: 'human', id: 'test-registrar' }, reason: 'TEST DATA in a throwaway database' });
    const before = await instrumentEvents(db.pool);
    const outcome = await run(db.pool, ARGS);
    const sha = createHash('sha256').update(readFileSync(EVIDENCE)).digest('hex');
    expect(outcome).toEqual({
      exitCode: 0,
      mode: 'dry_run',
      reportSha256: sha,
      plan: {
        mapping: { instrumentId: ETH_USD.instrumentId, provider: 'etoro', providerSymbol: '100001', providerInstrumentId: '100001', validFrom: NOW },
        by: { kind: 'human', id: 'operator-1' },
        reason: 'O22 governed eToro mapping by a named human; evidence ' + sha + ' (type Crypto, symbol ETH)',
      },
    });
    expect(await instrumentEvents(db.pool)).toBe(before);
    expect((await registryOf(db.pool)).resolve('etoro', '100001', NOW)).toBeNull();
  });

  it('without an ETH/USD instrument the tool refuses and creates nothing (it never registers an instrument)', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    expect(await run(db.pool, ARGS)).toEqual({ exitCode: 1, error: 'MAPPING_INSTRUMENT_INVALID' });
    expect(await instrumentEvents(db.pool)).toBe(0);
  });

  it('an instrument that already has an eToro mapping is not mapped twice', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const registry = await registryOf(db.pool);
    await registry.registerWithMapping(ETH_USD, { provider: 'etoro', providerSymbol: '100001', validFrom: '2026-10-18T00:00:00.000Z' }, { at: '2026-10-18T00:00:00.000Z', by: { kind: 'human', id: 'test-registrar' }, reason: 'TEST DATA' });
    const before = await instrumentEvents(db.pool);
    expect(await run(db.pool, ARGS)).toEqual({ exitCode: 1, error: 'MAPPING_CONFLICT' });
    expect(await instrumentEvents(db.pool)).toBe(before);
  });
});
