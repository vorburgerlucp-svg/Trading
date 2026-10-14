// Start of the NEXUS runtime: configuration, PostgreSQL, migration check, composition, HTTP. Fail closed at every step.
// The order is fixed. The configuration refuses live trading before anything is opened. The database must answer and must
// carry exactly the repository's migrations. Only then does the server listen. Nothing here migrates, repairs or falls back.

import { createPool, type PgPool } from '../persistence/postgres/pool.js';
import { MigrationError, loadMigrations, verifyMigrations } from '../persistence/postgres/migrator.js';
import { openPostgresMarketDataStores } from '../persistence/postgres/postgres-stores.js';
import { PostgresAppendOnlyStore } from '../persistence/postgres/postgres-append-only-store.js';
import type { MarketDataProvider } from '../market-data/market-data-provider.js';
import { TwelveDataMarketDataProvider } from '../market-data/providers/twelve-data.js';
import type { KillSwitchState } from '../safety/portfolio-safety-envelope.js';
import { createRuntimeHandler } from './app.js';
import { RuntimeConfigError, loadRuntimeConfig, summarizeRuntimeConfig, type Environment, type RuntimeConfig, type RuntimeConfigSummary } from './config.js';
import { composeRuntime } from './compose.js';
import { startHttpServer, type RunningServer } from './server.js';

export const RUNTIME_VERSION = 'nexus-runtime:v1' as const;

export type RuntimeStartCode = 'DATABASE_UNAVAILABLE' | 'MIGRATIONS_PENDING' | 'MIGRATIONS_MISMATCH';

export class RuntimeStartError extends Error {
  override readonly name = 'RuntimeStartError';
  constructor(
    readonly code: RuntimeStartCode,
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

export interface RuntimeHandle {
  readonly url: string;
  readonly config: RuntimeConfigSummary;
  /** Stops accepting requests and closes open connections, then releases the PostgreSQL pool. */
  close(): Promise<void>;
}

export interface StartOptions {
  /** Tests inject a fixture provider here. The entry point never passes one: the provider comes from the environment. */
  provider?: MarketDataProvider | null;
  clock?: () => Date;
}

export async function startRuntime(env: Environment, options: StartOptions = {}): Promise<RuntimeHandle> {
  const config = loadRuntimeConfig(env);
  const pool = createPool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 5_000, applicationName: 'nexus-runtime' });
  try {
    await requireMigratedDatabase(pool);
    const stores = await openPostgresMarketDataStores(pool);
    const killSwitch = await PostgresAppendOnlyStore.open<KillSwitchState>(pool, 'portfolio-kill-switch');
    const summary = summarizeRuntimeConfig(config);
    const services = await composeRuntime({
      instruments: stores.instruments,
      marketData: stores.marketData,
      quantRuns: stores.quantRuns,
      killSwitch,
      provider: options.provider !== undefined ? options.provider : providerFor(config),
      marketDataMode: summary.marketData,
      ping: () => ping(pool),
      version: RUNTIME_VERSION,
      ...(options.clock ? { clock: options.clock } : {}),
    });
    const server = await startHttpServer(createRuntimeHandler(services), { host: config.host, port: config.port });
    return {
      url: server.url,
      config: summary,
      close: () => stopAll(server, pool),
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/**
 * Prints only what this code base wrote: typed errors with their fixed messages (none of them contains a value from the
 * environment), and for anything else the error name and code. A driver message may carry a connection detail, so it is never printed.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof RuntimeConfigError || error instanceof RuntimeStartError || error instanceof MigrationError) return error.message;
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  return 'startup failed (' + name + (typeof code === 'string' ? ' ' + code : '') + ')';
}

async function stopAll(server: RunningServer, pool: PgPool): Promise<void> {
  try {
    await server.close();
  } finally {
    await pool.end();
  }
}

async function ping(pool: PgPool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function requireMigratedDatabase(pool: PgPool): Promise<void> {
  if (!(await ping(pool))) throw new RuntimeStartError('DATABASE_UNAVAILABLE', 'PostgreSQL does not answer; the runtime does not start without it');
  let status: { upToDate: boolean; pending: number[] };
  try {
    status = await verifyMigrations(pool, loadMigrations());
  } catch (error) {
    if (error instanceof MigrationError) throw new RuntimeStartError('MIGRATIONS_MISMATCH', error.message);
    throw error;
  }
  if (!status.upToDate) {
    throw new RuntimeStartError('MIGRATIONS_PENDING', 'migrations ' + status.pending.join(', ') + ' are not applied: run npm run db:migrate (the runtime never migrates by itself)');
  }
}

function providerFor(config: RuntimeConfig): MarketDataProvider | null {
  if (config.twelveData.apiKey !== null) return new TwelveDataMarketDataProvider({ apiKey: config.twelveData.apiKey, environment: 'production' });
  if (config.twelveData.demo) return TwelveDataMarketDataProvider.publicDemo();
  return null;
}
