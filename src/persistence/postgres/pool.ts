// PostgreSQL connection pool. Credentials come ONLY from the server-side environment (DATABASE_URL)
// and are never logged, returned or embedded in errors.

import pg from 'pg';

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

export class DatabaseConfigError extends Error {
  override readonly name = 'DatabaseConfigError';
}

export function createPoolFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, options: { max?: number; applicationName?: string } = {}): PgPool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new DatabaseConfigError('DATABASE_URL is not set (server-side environment variable; never commit it)');
  return createPool({ connectionString, ...options });
}

export function createPool(config: pg.PoolConfig & { applicationName?: string }): PgPool {
  const pool = new pg.Pool({ max: 10, ...config, application_name: config.applicationName ?? 'nexus' });
  // An idle client error must not crash the process, and must not print connection details.
  pool.on('error', (error) => {
    console.error('[nexus-db] idle client error:', (error as { code?: string }).code ?? error.name);
  });
  return pool;
}
