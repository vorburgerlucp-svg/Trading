// O22: the governed eToro mapping tool (B4). A named human adds the eToro mapping of ONE existing NEXUS instrument, with the stored
// report of the fixed metadata read (etoro-observe-cli --source=instrument-metadata) as evidence. It sends no broker request.
//
//   npm run etoro:map-instrument -- --instrument-id=<NEXUS id> --metadata-report=<file> --valid-from=<UTC ISO> --operator=<id>
//       (dry run: prints the plan, writes nothing)
//   npm run etoro:map-instrument -- ... --apply --confirm-human-mapping
//       (writes exactly one append-only registry event)
//
// The report must be the unchanged JSON the observation tool printed: schema etoro-instrument-metadata-observation:v1, verdict
// accepted. Its sha256 (of the file bytes) is cited in the registry event. Every check of planGovernedEtoroMapping runs before
// anything is written; a refusal writes nothing. Nothing is registered or mapped from a symbol: the human names the instrument.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { InstrumentRegistry } from '../../market-data/instrument-registry.js';
import { openRegistryReadOnly } from '../../market-data/registry-inspect-cli.js';
import { createPoolFromEnv } from '../../persistence/postgres/pool.js';
import { openPostgresMarketDataStores } from '../../persistence/postgres/postgres-stores.js';
import { INSTRUMENT_METADATA_REPORT_VERSION, parseInstrumentMetadata } from './etoro-instrument-metadata.js';
import { EtoroMappingError, planGovernedEtoroMapping, type GovernedEtoroMappingPlan } from './etoro-instrument-mapping.js';

export const APPLY_FLAG = '--apply';
export const CONFIRM_MAPPING_FLAG = '--confirm-human-mapping';
const VALUE_FLAGS = ['--instrument-id=', '--metadata-report=', '--valid-from=', '--operator='] as const;

export type MappingOutcome =
  | { readonly exitCode: 0; readonly mode: 'dry_run' | 'applied'; readonly plan: GovernedEtoroMappingPlan; readonly reportSha256: string }
  | { readonly exitCode: 1 | 2; readonly error: string };

export interface MappingRun {
  argv: readonly string[];
  now: string;
  readFile: (path: string) => Buffer;
  /** Opens the instrument registry; the default is the PostgreSQL registry of the runtime. */
  openRegistry: () => Promise<{ registry: InstrumentRegistry; close: () => Promise<void> }>;
}

function valueOf(argv: readonly string[], prefix: string): string | null {
  const hits = argv.filter((a) => a.startsWith(prefix));
  return hits.length === 1 ? hits[0]!.slice(prefix.length) : null;
}

export async function runMapping(run: MappingRun): Promise<MappingOutcome> {
  const unknown = run.argv.filter((a) => a !== APPLY_FLAG && a !== CONFIRM_MAPPING_FLAG && !VALUE_FLAGS.some((p) => a.startsWith(p)));
  if (unknown.length > 0) return { exitCode: 2, error: 'unknown argument' };
  const [instrumentId, reportPath, validFrom, operator] = VALUE_FLAGS.map((p) => valueOf(run.argv, p));
  if (!instrumentId || !reportPath || !validFrom || !operator) return { exitCode: 2, error: 'refused: pass exactly one each of ' + VALUE_FLAGS.join('…, ') + '…' };
  const apply = run.argv.includes(APPLY_FLAG);
  if (apply && !run.argv.includes(CONFIRM_MAPPING_FLAG)) return { exitCode: 2, error: 'refused: ' + APPLY_FLAG + ' needs ' + CONFIRM_MAPPING_FLAG };

  let bytes: Buffer;
  try {
    bytes = run.readFile(reportPath);
  } catch {
    return { exitCode: 2, error: 'refused: the metadata report cannot be read' };
  }
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { exitCode: 2, error: 'refused: the metadata report is not JSON' };
  }
  if (report.schema !== INSTRUMENT_METADATA_REPORT_VERSION || report.verdict !== 'accepted') return { exitCode: 2, error: 'refused: the report is not an accepted instrument metadata report' };
  let metadata;
  try {
    const m = report.metadata as Record<string, unknown>;
    metadata = parseInstrumentMetadata({ results: [m] }, typeof m?.instrumentId === 'number' ? m.instrumentId : -1);
  } catch {
    return { exitCode: 2, error: 'refused: the report metadata does not validate' };
  }
  const reportSha256 = createHash('sha256').update(bytes).digest('hex');

  const { registry, close } = await run.openRegistry();
  try {
    const plan = planGovernedEtoroMapping(registry, { instrumentId, validFrom, evidence: { metadata, reportSha256 } }, { kind: 'human', id: operator }, run.now);
    if (!apply) return { exitCode: 0, mode: 'dry_run', plan, reportSha256 };
    await registry.addMapping(plan.mapping, { at: run.now, by: plan.by, reason: plan.reason });
    return { exitCode: 0, mode: 'applied', plan, reportSha256 };
  } catch (error) {
    return { exitCode: 1, error: error instanceof EtoroMappingError ? error.code : 'MAPPING_FAILED' };
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const outcome = await runMapping({
    argv: process.argv.slice(2),
    now: new Date().toISOString(),
    readFile: (path) => readFileSync(path),
    // A dry run opens the registry strictly read-only (read-only session and store: nothing at all is written, not even a log row).
    // Only --apply opens it for the one append.
    openRegistry: async () => {
      if (!process.argv.includes(APPLY_FLAG)) return openRegistryReadOnly(process.env);
      const pool = createPoolFromEnv(process.env, { max: 1, applicationName: 'nexus-etoro-map-instrument' });
      const stores = await openPostgresMarketDataStores(pool);
      return { registry: await InstrumentRegistry.open(stores.instruments), close: () => pool.end() };
    },
  });
  if (outcome.exitCode === 0) process.stdout.write(JSON.stringify({ mode: outcome.mode, mapping: outcome.plan.mapping, by: outcome.plan.by, reportSha256: outcome.reportSha256 }, null, 2) + '\n');
  else process.stderr.write(outcome.error + '\n');
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A database failure prints a fixed text only: a driver message may carry a connection detail.
  main().catch(() => {
    process.stderr.write('MAPPING_FAILED: the registry could not be opened or written\n');
    process.exitCode = 1;
  });
}
