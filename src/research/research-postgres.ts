// R1: the PostgreSQL wiring of the research instance. It opens only the research database and only the stores R1 needs:
// instruments (with the same projector as the runtime), market data, and the day logs of the run protocol. Nothing here opens a
// broker, capital, audit or execution store.

import { InstrumentRegistry, type InstrumentEvent } from '../market-data/instrument-registry.js';
import { AppendOnlyLog, type AppendOnlyStore } from '../persistence/append-only-log.js';
import { instrumentProjector } from '../persistence/postgres/market-data-projectors.js';
import { verifyMigrations } from '../persistence/postgres/migrator.js';
import { PostgresAppendOnlyStore } from '../persistence/postgres/postgres-append-only-store.js';
import { PostgresMarketDataStore } from '../persistence/postgres/postgres-market-data-store.js';
import { createPool, type PgPool } from '../persistence/postgres/pool.js';
import type { ResearchRunRecord } from './research-run-log.js';

export class ResearchDatabaseError extends Error {
  override readonly name = 'ResearchDatabaseError';
}

/** A small pool: one worker needs the lock connection plus one or two for its statements. */
export function openResearchPool(databaseUrl: string, options: { readOnly: boolean; applicationName: string }): PgPool {
  return createPool({
    connectionString: databaseUrl,
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    applicationName: options.applicationName,
    // statement_timeout bounds every statement; a read-only session makes PostgreSQL refuse every write.
    options: '-c statement_timeout=60000' + (options.readOnly ? ' -c default_transaction_read_only=on' : ''),
  });
}

/**
 * Checks, on the open connection, that it really is the research database and role (not only what the URL said), and that the
 * schema is exactly the repository's migrations. The research instance never migrates by itself.
 */
export async function assertResearchDatabase(pool: PgPool, expected: { name: string; user: string }): Promise<void> {
  const row = (await pool.query<{ db: string; usr: string }>('SELECT current_database() AS db, current_user AS usr')).rows[0];
  if (row?.db !== expected.name || row.usr !== expected.user) throw new ResearchDatabaseError('connected database or role is not the configured research one');
  const migrations = await verifyMigrations(pool);
  if (!migrations.upToDate) throw new ResearchDatabaseError('research database schema is not up to date (pending migrations: ' + migrations.pending.join(', ') + '); run research:migrate first');
}

export interface ResearchStores {
  instruments: AppendOnlyStore<InstrumentEvent>;
  marketData: PostgresMarketDataStore;
  openRunLog: (name: string) => Promise<AppendOnlyLog<ResearchRunRecord>>;
}

export async function openResearchStores(pool: PgPool): Promise<ResearchStores> {
  return {
    instruments: await PostgresAppendOnlyStore.open<InstrumentEvent>(pool, 'instruments', { projector: instrumentProjector }),
    marketData: new PostgresMarketDataStore(pool),
    openRunLog: async (name) => AppendOnlyLog.open<ResearchRunRecord>(name, await PostgresAppendOnlyStore.open<ResearchRunRecord>(pool, name)),
  };
}

/** Read-only stores: opening them writes nothing, every append is refused. */
export function openResearchStoresReadOnly(pool: PgPool): { registry: () => Promise<InstrumentRegistry>; marketData: PostgresMarketDataStore; openRunLog: (name: string) => Promise<AppendOnlyLog<ResearchRunRecord>> } {
  return {
    registry: () => InstrumentRegistry.open(PostgresAppendOnlyStore.openReadOnly<InstrumentEvent>(pool, 'instruments')),
    marketData: new PostgresMarketDataStore(pool),
    openRunLog: (name) => AppendOnlyLog.open<ResearchRunRecord>(name, PostgresAppendOnlyStore.openReadOnly<ResearchRunRecord>(pool, name)),
  };
}
