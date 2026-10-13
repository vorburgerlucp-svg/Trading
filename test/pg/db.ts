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

/**
 * A dropped connection (e.g. after the machine slept, or DROP DATABASE ... WITH (FORCE) on a test that
 * timed out) emits 'error' on the client; without a listener that crashes the whole run. The failure
 * still reaches the test through the pending query's rejection.
 */
function client(config: pg.ClientConfig): pg.Client {
  const c = new pg.Client(config);
  c.on('error', () => undefined);
  return c;
}

/** Diagnostics (NEXUS_PG_WATCHDOG=1): reports slow setup/teardown steps. */
async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (process.env.NEXUS_PG_WATCHDOG !== '1') return run();
  const started = Date.now();
  const timer = setInterval(() => console.log('[pg-db] still waiting: ' + label + ' after ' + Math.round((Date.now() - started) / 1000) + 's'), 10_000);
  try {
    return await run();
  } finally {
    clearInterval(timer);
    if (Date.now() - started > 3_000) console.log('[pg-db] slow: ' + label + ' took ' + (Date.now() - started) + 'ms');
  }
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!pgInfo.available) throw new Error('PostgreSQL not available: ' + pgInfo.reason);
  const { connection, adminDatabase } = pgInfo;
  const name = 'nexus_t_' + randomBytes(6).toString('hex');
  const admin = client({ ...connection, database: adminDatabase });
  await timed('connect admin', () => admin.connect());
  await timed('create ' + name, () => admin.query('CREATE DATABASE ' + name + ' TEMPLATE nexus_template'));
  await timed('end admin', () => admin.end());
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
      const privileged = client({ ...connection, database: name });
      await privileged.connect();
      return privileged;
    },
    drop: async () => {
      const stats = pools.map((p) => p.totalCount + '/' + p.idleCount + '/' + p.waitingCount).join(' ');
      await timed('end pools (total/idle/waiting ' + stats + ')', () => Promise.all(pools.map((p) => p.end().catch(() => undefined))));
      const a = client({ ...connection, database: adminDatabase });
      await timed('connect admin for drop', () => a.connect());
      await timed('drop ' + name, () => a.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)'));
      await timed('end admin after drop', () => a.end());
    },
  };
}
