// Global setup for the PostgreSQL integration project.
// Order of preference:
//   1. NEXUS_TEST_DATABASE_URL (an existing, disposable PostgreSQL, e.g. a CI service container)
//   2. a throwaway local PostgreSQL started from the official binaries (test/pg/pg-server.ts)
// If neither works, the project FAILS. PostgreSQL integration tests are mandatory for `npm run check`:
// a missing server must never turn into skipped tests and a green run. The fast check without
// PostgreSQL is `npm run check:fast` and is explicitly not a complete check.

import type { TestProject } from 'vitest/node';
import pg from 'pg';
import { loadMigrations, migrate } from '../../src/persistence/postgres/migrator.js';
import { PG_WINDOWS_PATH_HINT, startPostgres, type PgConnectionInfo, type RunningPostgres } from './pg-server.js';

/** The failure text names the cause and the fix, so a red run is actionable. */
export function pgRequiredMessage(reason: string): string {
  const lines = [
    'NEXUS PostgreSQL integration tests are REQUIRED, but PostgreSQL could not be started.',
    '  reason: ' + reason,
    '  npm run check is NOT complete without them, so it fails here. Use npm run check:fast only for a quick, explicitly incomplete check.',
  ];
  if (process.platform === 'win32' && /not installed|not found|did not start/.test(reason)) lines.push('  ' + PG_WINDOWS_PATH_HINT);
  return lines.join('\n');
}

export const TEMPLATE_DB = 'nexus_template';

declare module 'vitest' {
  export interface ProvidedContext {
    pg: { available: true; connection: PgConnectionInfo; adminDatabase: string; version: string; origin: string } | { available: false; reason: string };
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let server: RunningPostgres | null = null;
  try {
    let connection: PgConnectionInfo;
    let adminDatabase = 'postgres';
    let origin: string;
    const external = process.env.NEXUS_TEST_DATABASE_URL;
    if (external) {
      const url = new URL(external);
      connection = { host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
      adminDatabase = url.pathname.replace(/^\//, '') || 'postgres';
      origin = 'NEXUS_TEST_DATABASE_URL';
    } else {
      server = await startPostgres();
      connection = server.connection;
      origin = 'local throwaway PostgreSQL ' + server.version;
    }

    // Template database with all migrations applied once; every test clones it (fast, isolated).
    const admin = new pg.Client({ ...connection, database: adminDatabase });
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS ' + TEMPLATE_DB);
    await admin.query('CREATE DATABASE ' + TEMPLATE_DB);
    const version = (await admin.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? '?';
    await admin.end();
    const pool = new pg.Pool({ ...connection, database: TEMPLATE_DB, max: 2 });
    await migrate(pool, loadMigrations());
    await pool.end();

    project.provide('pg', { available: true, connection, adminDatabase, version, origin });
    console.log('[pg] integration tests run against ' + origin + ' (server ' + version + ')');
    if (process.env.NEXUS_PG_WATCHDOG === '1') watchdog = startWatchdog(connection, adminDatabase);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
    if (server) await server.stop();
    server = null;
    throw new Error(pgRequiredMessage(reason));
  }
  return async () => {
    if (watchdog) clearInterval(watchdog);
    if (server) await server.stop();
  };
}

let watchdog: ReturnType<typeof setInterval> | undefined;

/** Diagnostics (NEXUS_PG_WATCHDOG=1): every 10 s, prints sessions that have been busy or waiting for > 10 s. */
function startWatchdog(connection: PgConnectionInfo, adminDatabase: string): ReturnType<typeof setInterval> {
  const timer = setInterval(async () => {
    const c = new pg.Client({ ...connection, database: adminDatabase, connectionTimeoutMillis: 5_000 });
    c.on('error', () => undefined);
    try {
      await c.connect();
      const { rows } = await c.query(
        `SELECT pid, datname, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers,
                round(extract(epoch FROM now() - query_start)) AS q_s, left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS q
           FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND backend_type = 'client backend' AND state <> 'idle' AND now() - query_start > interval '10 seconds'`,
      );
      const counts = await c.query(`SELECT datname, state, count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1, 2 ORDER BY 1, 2`);
      if (rows.length > 0) console.log('[pg-watchdog] ' + new Date().toISOString() + ' stuck: ' + JSON.stringify(rows) + ' sessions: ' + JSON.stringify(counts.rows));
    } catch (error) {
      console.log('[pg-watchdog] ' + new Date().toISOString() + ' cannot query server: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      await c.end().catch(() => undefined);
    }
  }, 10_000);
  timer.unref();
  return timer;
}
