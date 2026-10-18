// O22: read-only inspection of the NEXUS instrument registry (for the ETH/USD and eToro 100001 mapping decision). It sends no
// network request except to the database named by DATABASE_URL, and it cannot write there:
//   - the session is opened with default_transaction_read_only=on, so PostgreSQL itself refuses every write;
//   - the instrument log is opened with PostgresAppendOnlyStore.openReadOnly: no log row is created, every append is refused.
// It prints instruments, their provider mappings and fixed checks; never DATABASE_URL, a key or any other configuration value.
//
//   npm run registry:inspect -- --symbol=ETH [--etoro-instrument-id=100001]

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { InstrumentRegistry } from './instrument-registry.js';
import type { Instrument, ProviderInstrumentMapping } from './market-data-types.js';
import { createPool } from '../persistence/postgres/pool.js';
import { PostgresAppendOnlyStore } from '../persistence/postgres/postgres-append-only-store.js';
import type { InstrumentEvent } from './instrument-registry.js';

export const REGISTRY_INSPECTION_VERSION = 'nexus-registry-inspection:v1' as const;
const QUERY = /^[A-Za-z0-9./ _-]{1,32}$/;

export interface InstrumentInspection {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly name: string | null;
  readonly assetClass: string;
  readonly currency: string;
  readonly active: boolean;
  readonly exchange: string | null;
  readonly timezone: string;
  readonly tradingCalendar: string | null;
  readonly mappings: readonly ProviderInstrumentMapping[];
  /** Fixed checks, read from the stored fields only. The base currency is not a registry field: it is not derived from the symbol. */
  readonly checks: {
    readonly crypto: boolean;
    readonly quotedInUsd: boolean;
    readonly symbolIsEthUsd: boolean;
    readonly openEtoroMapping: string | null;
    readonly openTwelveDataMapping: string | null;
  };
}

export interface RegistryInspection {
  readonly schema: typeof REGISTRY_INSPECTION_VERSION;
  readonly readOnly: true;
  readonly at: string;
  readonly query: string;
  readonly instrumentCount: number;
  readonly matches: readonly InstrumentInspection[];
  /** The NEXUS instrument an eToro id resolves to at `at` (provider etoro, no exchange), when asked. */
  readonly etoro: { readonly etoroInstrumentId: number; readonly resolvesTo: string | null } | null;
}

function openMapping(mappings: readonly ProviderInstrumentMapping[], provider: string, at: string): string | null {
  const t = Date.parse(at);
  const m = mappings.find((x) => x.provider === provider && Date.parse(x.validFrom) <= t && (x.validTo === undefined || t < Date.parse(x.validTo)));
  return m === undefined ? null : m.providerSymbol + (m.exchange ? ' @ ' + m.exchange : '');
}

function inspect(instrument: Instrument, mappings: readonly ProviderInstrumentMapping[], at: string): InstrumentInspection {
  return {
    instrumentId: instrument.instrumentId,
    symbol: instrument.symbol,
    name: instrument.name ?? null,
    assetClass: instrument.assetClass,
    currency: instrument.currency,
    active: instrument.active,
    exchange: instrument.exchange ?? null,
    timezone: instrument.timezone,
    tradingCalendar: instrument.tradingCalendar ?? null,
    mappings,
    checks: {
      crypto: instrument.assetClass === 'crypto',
      quotedInUsd: instrument.currency === 'USD',
      symbolIsEthUsd: instrument.symbol.toUpperCase() === 'ETH/USD',
      openEtoroMapping: openMapping(mappings, 'etoro', at),
      openTwelveDataMapping: openMapping(mappings, 'twelvedata', at),
    },
  };
}

/** Pure: the instruments whose symbol, name or any provider symbol contains the query (case-insensitive). */
export function inspectRegistry(registry: InstrumentRegistry, query: string, at: string, etoroInstrumentId: number | null): RegistryInspection {
  const q = query.toUpperCase();
  const all = registry.list();
  const matches = all
    .map((i) => ({ i, mappings: registry.mappings(i.instrumentId) }))
    .filter(({ i, mappings }) => i.symbol.toUpperCase().includes(q) || (i.name ?? '').toUpperCase().includes(q) || mappings.some((m) => m.providerSymbol.toUpperCase().includes(q)))
    .map(({ i, mappings }) => inspect(i, mappings, at));
  return {
    schema: REGISTRY_INSPECTION_VERSION,
    readOnly: true,
    at,
    query,
    instrumentCount: all.length,
    matches,
    etoro: etoroInstrumentId === null ? null : { etoroInstrumentId, resolvesTo: registry.resolve('etoro', String(etoroInstrumentId), at) },
  };
}

export type InspectOutcome = { readonly exitCode: 0; readonly report: RegistryInspection } | { readonly exitCode: 1 | 2; readonly error: string };

export interface InspectRun {
  argv: readonly string[];
  now: string;
  openRegistry: () => Promise<{ registry: InstrumentRegistry; close: () => Promise<void> }>;
}

export async function runInspect(run: InspectRun): Promise<InspectOutcome> {
  const unknown = run.argv.filter((a) => !a.startsWith('--symbol=') && !a.startsWith('--etoro-instrument-id='));
  if (unknown.length > 0) return { exitCode: 2, error: 'unknown argument' };
  const symbols = run.argv.filter((a) => a.startsWith('--symbol=')).map((a) => a.slice('--symbol='.length));
  if (symbols.length !== 1 || !QUERY.test(symbols[0]!)) return { exitCode: 2, error: 'refused: pass exactly one --symbol=<1-32 plain characters>' };
  const ids = run.argv.filter((a) => a.startsWith('--etoro-instrument-id=')).map((a) => a.slice('--etoro-instrument-id='.length));
  if (ids.length > 1 || (ids.length === 1 && !/^[1-9][0-9]{0,9}$/.test(ids[0]!))) return { exitCode: 2, error: 'refused: --etoro-instrument-id must be one positive integer' };
  let opened: { registry: InstrumentRegistry; close: () => Promise<void> };
  try {
    opened = await run.openRegistry();
  } catch {
    return { exitCode: 1, error: 'REGISTRY_UNAVAILABLE: the database could not be read' };
  }
  try {
    return { exitCode: 0, report: inspectRegistry(opened.registry, symbols[0]!, run.now, ids.length === 1 ? Number(ids[0]) : null) };
  } finally {
    await opened.close();
  }
}

/** Opens the registry of DATABASE_URL strictly read-only (session default_transaction_read_only, read-only store). */
export async function openRegistryReadOnly(env: Readonly<Record<string, string | undefined>>): Promise<{ registry: InstrumentRegistry; close: () => Promise<void> }> {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = createPool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, applicationName: 'nexus-registry-read-only', options: '-c default_transaction_read_only=on' });
  try {
    const registry = await InstrumentRegistry.open(PostgresAppendOnlyStore.openReadOnly<InstrumentEvent>(pool, 'instruments'));
    return { registry, close: () => pool.end() };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const outcome = await runInspect({ argv: process.argv.slice(2), now: new Date().toISOString(), openRegistry: () => openRegistryReadOnly(process.env) });
  if (outcome.exitCode === 0) process.stdout.write(JSON.stringify(outcome.report, null, 2) + '\n');
  else process.stderr.write(outcome.error + '\n');
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('REGISTRY_UNAVAILABLE: the database could not be read\n');
    process.exitCode = 1;
  });
}
