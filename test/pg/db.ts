// Per-test isolated databases cloned from the migrated template. TEST ONLY.

import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import pg from 'pg';
import { createPool, type PgPool } from '../../src/persistence/postgres/pool.js';

export const pgInfo = inject('pg');
export const pgAvailable = pgInfo.available;
export const pgSkipReason = pgInfo.available ? '' : pgInfo.reason;

export interface TestDatabase {
  pool: PgPool;
  name: string;
  /** Opens an extra pool on the same database (simulates another NEXUS server process). */
  extraPool(): PgPool;
  /** Superuser-level client for adversarial tests (bypassing application and triggers). */
  privilegedClient(): Promise<pg.Client>;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!pgInfo.available) throw new Error('PostgreSQL not available: ' + pgInfo.reason);
  const { connection, adminDatabase } = pgInfo;
  const name = 'nexus_t_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ ...connection, database: adminDatabase });
  await admin.connect();
  await admin.query('CREATE DATABASE ' + name + ' TEMPLATE nexus_template');
  await admin.end();
  const pools: PgPool[] = [];
  const open = () => {
    const pool = createPool({ ...connection, database: name, max: 20, applicationName: 'nexus-test' });
    pools.push(pool);
    return pool;
  };
  const pool = open();
  return {
    pool,
    name,
    extraPool: open,
    privilegedClient: async () => {
      const client = new pg.Client({ ...connection, database: name });
      await client.connect();
      return client;
    },
    drop: async () => {
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
      const a = new pg.Client({ ...connection, database: adminDatabase });
      await a.connect();
      await a.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
      await a.end();
    },
  };
}
