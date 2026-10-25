// R1 research status (npm run research:status): prints the read-only status of the research instance as JSON. The session is
// read-only (default_transaction_read_only) and the stores are opened read-only: this command cannot write, register a log,
// fetch from a provider or touch any other database.

import { existsSync, readFileSync } from 'node:fs';
import { parseResearchCatalog, RESEARCH_SOURCE_ID } from './research-catalog.js';
import { DEFAULT_RESEARCH_LIMITS, loadResearchDatabaseConfig, RESEARCH_ENV_FILE } from './research-config.js';
import { assertResearchDatabase, openResearchPool, openResearchStoresReadOnly } from './research-postgres.js';
import { recordsOf, researchRunLogName } from './research-run-log.js';
import { researchStatus } from './research-status.js';

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  if (existsSync(RESEARCH_ENV_FILE)) process.loadEnvFile(RESEARCH_ENV_FILE);
  const config = loadResearchDatabaseConfig(process.env);
  const catalogFile = process.env.NEXUS_RESEARCH_CATALOG_FILE?.trim();
  if (!catalogFile) throw new Error('NEXUS_RESEARCH_CATALOG_FILE is not set');
  const catalog = parseResearchCatalog(readFileSync(catalogFile, 'utf8'));
  const pool = openResearchPool(config.databaseUrl, { readOnly: true, applicationName: 'nexus-research-status' });
  try {
    await assertResearchDatabase(pool, config.database);
    const stores = openResearchStoresReadOnly(pool);
    const nowMs = Date.now();
    const logs = { yesterday: await stores.openRunLog(researchRunLogName(nowMs - DAY_MS)), today: await stores.openRunLog(researchRunLogName(nowMs)) };
    const budget = { dailyCredits: Number(process.env.NEXUS_RESEARCH_DAILY_CREDIT_LIMIT ?? DEFAULT_RESEARCH_LIMITS.dailyCredits), minuteCredits: Number(process.env.NEXUS_RESEARCH_MINUTE_CREDIT_LIMIT ?? DEFAULT_RESEARCH_LIMITS.minuteCredits) };
    const status = await researchStatus({ catalog, records: recordsOf(logs), marketData: stores.marketData, sourceId: RESEARCH_SOURCE_ID, budget, nowMs });
    console.log(JSON.stringify(status, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).name + ': ' + (error as Error).message);
  process.exitCode = 1;
});
