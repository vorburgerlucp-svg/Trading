// R1 research schema step (npm run research:migrate): applies the repository's migrations (db/migrations, the same files as the
// productive database) to the research database ONLY. The connection is refused unless it is nexus_research with a
// nexus_research role (checked on the URL and again on the open connection). It never runs by itself: the research worker
// refuses to start on a schema that is not up to date.

import { existsSync } from 'node:fs';
import { loadMigrations, migrate } from '../persistence/postgres/migrator.js';
import { loadResearchDatabaseConfig, RESEARCH_ENV_FILE } from './research-config.js';
import { openResearchPool, ResearchDatabaseError } from './research-postgres.js';

async function main(): Promise<void> {
  if (existsSync(RESEARCH_ENV_FILE)) process.loadEnvFile(RESEARCH_ENV_FILE);
  const config = loadResearchDatabaseConfig(process.env);
  const pool = openResearchPool(config.databaseUrl, { readOnly: false, applicationName: 'nexus-research-migrate' });
  try {
    const row = (await pool.query<{ db: string; usr: string }>('SELECT current_database() AS db, current_user AS usr')).rows[0];
    if (row?.db !== config.database.name || row.usr !== config.database.user) throw new ResearchDatabaseError('connected database or role is not the configured research one');
    const report = await migrate(pool, loadMigrations());
    console.log('research migrations applied now: ' + (report.applied.join(', ') || 'none') + '; already applied before: ' + report.alreadyApplied.length);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).name + ': ' + (error as Error).message);
  process.exitCode = 1;
});
