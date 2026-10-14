// Explicit schema step (npm run db:migrate). This is the only place that changes the database schema. The runtime itself
// only verifies the schema and refuses to start on anything other than the repository's exact migrations.

import { existsSync } from 'node:fs';
import { loadMigrations, migrate } from '../persistence/postgres/migrator.js';
import { createPool } from '../persistence/postgres/pool.js';
import { describeFailure } from './bootstrap.js';
import { loadRuntimeConfig } from './config.js';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadRuntimeConfig(process.env);
  const pool = createPool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 5_000, applicationName: 'nexus-migrate' });
  try {
    const report = await migrate(pool, loadMigrations());
    console.log('migrations applied now: ' + (report.applied.join(', ') || 'none') + '; already applied before: ' + report.alreadyApplied.length);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(describeFailure(error));
  process.exitCode = 1;
});
