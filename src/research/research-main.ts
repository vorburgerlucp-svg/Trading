// R1 research entry point: ONE bounded run, then the process exits. It is started by a scheduler (a reviewed Windows task draft,
// ops/research/), never runs as an unbounded background process, and has no HTTP server and no port.
//
// This entry point is deliberately separate from src/runtime/main.ts: it composes only market data and the research stores.
// test/research/research-isolation.test.ts proves that its complete import graph reaches no broker, execution, runtime, model or
// capital component. It reads only .env.research (never .env), and refuses to start with any broker or production variable set.

import { existsSync, readFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { TwelveDataMarketDataProvider } from '../market-data/providers/twelve-data.js';
import type { FetchLike } from '../market-data/providers/resilience.js';
import { parseResearchCatalog, RESEARCH_SOURCE_ID } from './research-catalog.js';
import { loadResearchConfig, RESEARCH_ENV_FILE } from './research-config.js';
import { PostgresWorkerLock } from './research-lock.js';
import { assertResearchDatabase, openResearchPool, openResearchStores } from './research-postgres.js';
import { runResearchOnce, type ResearchRunOutcome } from './research-worker.js';

/** Fixed source metadata: changing it later would conflict with the registered source (the clearance itself is in the run protocol). */
export const RESEARCH_LICENSE_NOTE = 'NEXUS research instance: internal, non-commercial research use under the Twelve Data terms; storage only with a documented clearance';
/** Grace after the run deadline before the process is ended hard (a hung request must not keep a worker alive). */
const HARD_STOP_GRACE_MS = 20_000;

/** Exit code of a run: 0 normal (including a skip because another worker runs), 2 needs attention, 1 failure. */
export function exitCodeOf(outcome: ResearchRunOutcome): number {
  if (outcome.kind === 'skipped') return outcome.reason === 'LOCK_HELD' ? 0 : 2;
  if (outcome.status === 'completed') return 0;
  return outcome.status === 'failed' ? 1 : 2;
}

/** The summary printed after a run: counts and codes only, never a key, URL or provider response. */
export function summaryOf(outcome: ResearchRunOutcome): Record<string, unknown> {
  if (outcome.kind === 'skipped') return { runId: outcome.runId, skipped: outcome.reason };
  return {
    runId: outcome.runId,
    status: outcome.status,
    creditsUsed: outcome.creditsUsed,
    abandonedRuns: outcome.abandonedRuns.length,
    instruments: outcome.instruments.map((i) => ({ id: i.instrumentId, outcome: i.outcome, inserted: i.inserted, unchanged: i.unchanged, historical: i.historicalReconstruction, ...(i.errorCode ? { error: i.errorCode } : {}) })),
  };
}

async function main(): Promise<void> {
  if (existsSync(RESEARCH_ENV_FILE)) process.loadEnvFile(RESEARCH_ENV_FILE);
  const config = loadResearchConfig(process.env);
  const catalog = parseResearchCatalog(readFileSync(config.catalogFile, 'utf8'));
  const hardStop = setTimeout(() => {
    console.error('research run exceeded its deadline: ending the process (the next run records it as abandoned)');
    process.exit(3);
  }, config.maxRunMs + HARD_STOP_GRACE_MS);
  hardStop.unref();

  const pool = openResearchPool(config.databaseUrl, { readOnly: false, applicationName: 'nexus-research-r1' });
  try {
    await assertResearchDatabase(pool, config.database);
    const stores = await openResearchStores(pool);
    const transport: FetchLike = (url, init) => fetch(url, init);
    const outcome = await runResearchOnce({
      catalog,
      settings: config,
      openRunLog: stores.openRunLog,
      instruments: stores.instruments,
      marketData: stores.marketData,
      lock: new PostgresWorkerLock(pool),
      providerWith: (guarded) =>
        new TwelveDataMarketDataProvider({ apiKey: config.twelveDataApiKey, environment: 'production', fetch: guarded, license: 'internal_use', licenseNote: RESEARCH_LICENSE_NOTE, minimalRequests: false }),
      fetch: transport,
      sourceId: RESEARCH_SOURCE_ID,
      freeMemoryMb: () => freemem() / (1024 * 1024),
    });
    console.log(JSON.stringify(summaryOf(outcome)));
    process.exitCode = exitCodeOf(outcome);
  } finally {
    await pool.end();
    clearTimeout(hardStop);
  }
}

// Started directly (node dist/research/research-main.js), not when imported by a test.
if (process.argv[1] !== undefined && /research-main\.(js|ts)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    // Name and message only: a configuration error never contains a secret value, and nothing else is printed.
    console.error((error as Error).name + ': ' + (error as Error).message);
    process.exitCode = 1;
  });
}
