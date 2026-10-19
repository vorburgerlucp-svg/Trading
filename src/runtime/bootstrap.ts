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
import { AppendOnlyLog } from '../persistence/append-only-log.js';
import { PostgresLedgerStore } from '../persistence/postgres/postgres-ledger-store.js';
import { CapitalLedger } from '../capital/capital-ledger.js';
import type { EtoroReconciliationRecord, EtoroSnapshotRecord, EtoroSyncRecord } from '../broker/etoro/etoro-broker-service.js';
import { HttpsEtoroTransport, type EtoroCredentials, type EtoroTransport } from '../broker/etoro/etoro-transport.js';
import { HttpsDemoExecutionTransport, type DemoExecutionTransport } from '../broker/etoro/execution/etoro-demo-execution-transport.js';
import type { AttemptRecord, ConfirmationRecord, IntentEvent, ReconciliationRecord } from '../broker/etoro/execution/etoro-demo-execution-service.js';
import type { DemoAccountValuationRecord } from '../broker/etoro/execution/demo-account-safety.js';
import { createRuntimeHandler } from './app.js';
import { OperatorAuthenticator } from './operator-auth.js';
import { RuntimeConfigError, loadRuntimeConfig, summarizeRuntimeConfig, type Environment, type RuntimeConfig, type RuntimeConfigSummary } from './config.js';
import { composeRuntime, type ComposeInput } from './compose.js';
import { startHttpServer, type RunningServer } from './server.js';

/** The ledger NEXUS books into. The eToro reconciliation reads it and never writes to it. */
const NEXUS_LEDGER_ID = 'main';

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
  /** Tests inject a fixture eToro transport here. The entry point never passes one: eToro is reached through the public API. */
  etoroTransport?: EtoroTransport;
  /** Tests inject a fixture demo execution transport here. The entry point never passes one. */
  etoroExecutionTransport?: DemoExecutionTransport;
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
    const etoro = config.etoro.enabled ? await openEtoro(pool, config, options) : undefined;
    const etoroDemoExecution = config.etoroDemoExecution.enabled ? await openEtoroDemoExecution(pool, config, options) : undefined;
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
      ...(etoro ? { etoro } : {}),
      ...(etoroDemoExecution ? { etoroDemoExecution } : {}),
    });
    // Operator authentication of the O21 control plane: from the configuration only. Without it, mutating demo routes are refused.
    const operatorAuth = config.operator !== null ? new OperatorAuthenticator(config.operator) : null;
    const server = await startHttpServer(createRuntimeHandler(services, { operatorAuth }), { host: config.host, port: config.port });
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

/**
 * The eToro demo read-only wiring (O20): the HTTPS transport with the configured keys, the ledger opened for reading only, and
 * three append-only logs. Nothing here creates the ledger or writes to it. The keys are read once, here, and never persisted.
 */
async function openEtoro(pool: PgPool, config: RuntimeConfig, options: StartOptions): Promise<NonNullable<ComposeInput['etoro']>> {
  const clock = options.clock ?? (() => new Date());
  const transport = options.etoroTransport ?? new HttpsEtoroTransport({ credentials: etoroCredentials(config) });
  const ledger = await CapitalLedger.open(await PostgresLedgerStore.openReadOnly(pool, NEXUS_LEDGER_ID));
  return {
    transport,
    ledger,
    snapshots: await AppendOnlyLog.open<EtoroSnapshotRecord>('etoro-snapshots', await PostgresAppendOnlyStore.open<EtoroSnapshotRecord>(pool, 'etoro-snapshots'), { clock }),
    reconciliations: await AppendOnlyLog.open<EtoroReconciliationRecord>('etoro-reconciliations', await PostgresAppendOnlyStore.open<EtoroReconciliationRecord>(pool, 'etoro-reconciliations'), { clock }),
    syncs: await AppendOnlyLog.open<EtoroSyncRecord>('etoro-sync-events', await PostgresAppendOnlyStore.open<EtoroSyncRecord>(pool, 'etoro-sync-events'), { clock }),
  };
}

/**
 * The eToro demo execution wiring (O21), only with ETORO_DEMO_EXECUTION_ENABLED=1: the demo execution transport and four
 * append-only logs, plus (O22) the valuation log of the demo account safety source. The evidence record says a non-empty
 * /demo/pnl was observed live, so the source decides from a fresh /demo/pnl read (it answers null on any failed or unverifiable
 * read, and every open is then refused); and the build lock BUILD_LOCKS.etoroDemoExecution refuses every write in this build.
 */
async function openEtoroDemoExecution(pool: PgPool, config: RuntimeConfig, options: StartOptions): Promise<NonNullable<ComposeInput['etoroDemoExecution']>> {
  const clock = options.clock ?? (() => new Date());
  return {
    transport: options.etoroExecutionTransport ?? new HttpsDemoExecutionTransport({ credentials: etoroCredentials(config) }),
    intents: await AppendOnlyLog.open<IntentEvent>('etoro-demo-execution-intents', await PostgresAppendOnlyStore.open<IntentEvent>(pool, 'etoro-demo-execution-intents'), { clock }),
    attempts: await AppendOnlyLog.open<AttemptRecord>('etoro-demo-execution-attempts', await PostgresAppendOnlyStore.open<AttemptRecord>(pool, 'etoro-demo-execution-attempts'), { clock }),
    confirmations: await AppendOnlyLog.open<ConfirmationRecord>('etoro-demo-broker-confirmations', await PostgresAppendOnlyStore.open<ConfirmationRecord>(pool, 'etoro-demo-broker-confirmations'), { clock }),
    reconciliations: await AppendOnlyLog.open<ReconciliationRecord>('etoro-demo-execution-reconciliations', await PostgresAppendOnlyStore.open<ReconciliationRecord>(pool, 'etoro-demo-execution-reconciliations'), { clock }),
    // O22: the risk day of the demo account safety source (equity valuations only; no account or position id).
    accountValuations: await AppendOnlyLog.open<DemoAccountValuationRecord>('etoro-demo-account-valuations', await PostgresAppendOnlyStore.open<DemoAccountValuationRecord>(pool, 'etoro-demo-account-valuations'), { clock }),
  };
}

function etoroCredentials(config: RuntimeConfig): EtoroCredentials {
  const { apiKey, userKey } = config.etoro;
  if (apiKey === null || userKey === null) throw new RuntimeConfigError('CONFIG_INVALID', 'ETORO_API_KEY and ETORO_USER_KEY are required when ETORO_ENABLED=1');
  return { apiKey, userKey };
}

function providerFor(config: RuntimeConfig): MarketDataProvider | null {
  if (config.twelveData.apiKey !== null) return new TwelveDataMarketDataProvider({ apiKey: config.twelveData.apiKey, environment: 'production' });
  if (config.twelveData.demo) return TwelveDataMarketDataProvider.publicDemo();
  return null;
}
