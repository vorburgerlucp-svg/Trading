// Global setup for the PostgreSQL integration project.
// Order of preference:
//   1. NEXUS_TEST_DATABASE_URL (an existing, disposable PostgreSQL, e.g. a CI service container)
//   2. a throwaway local PostgreSQL started from the official binaries (test/pg/pg-server.ts)
// If neither works, the reason is provided to the tests, which then report themselves as skipped
// with that reason (never silently "green").

import type { TestProject } from 'vitest/node';
import pg from 'pg';
import { loadMigrations, migrate } from '../../src/persistence/postgres/migrator.js';
import { startPostgres, type PgConnectionInfo, type RunningPostgres } from './pg-server.js';

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
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
    project.provide('pg', { available: false, reason });
    console.warn('[pg] PostgreSQL integration tests NOT RUN: ' + reason);
    if (server) await server.stop();
    server = null;
  }
  return async () => {
    if (server) await server.stop();
  };
}
