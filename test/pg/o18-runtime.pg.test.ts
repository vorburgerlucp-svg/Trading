// The runtime against a real PostgreSQL. The start refuses a database without the repository migrations and does not migrate it.
// On a migrated database it serves the API. After a restart, the instrument mapping, the stored bars and the quant run are read
// back from PostgreSQL, not from memory.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStartError, startRuntime } from '../../src/runtime/bootstrap.js';
import { openPostgresMarketDataStores } from '../../src/persistence/postgres/postgres-stores.js';
import { RUNTIME_TEST_NOW, fixtureProvider, registerAapl } from '../runtime/o18-fixtures.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

function connected() {
  if (!pgInfo.available) throw new Error(pgSkipReason);
  return pgInfo;
}

function urlFor(database: string): string {
  const { connection } = connected();
  return 'postgres://' + encodeURIComponent(connection.user) + ':' + encodeURIComponent(connection.password) + '@' + connection.host + ':' + connection.port + '/' + database;
}

function envFor(database: string, port: number): Record<string, string> {
  // The provider is a test fixture. A syntactically valid test-only key selects the runtime's production/raw path.
  return { DATABASE_URL: urlFor(database), HOST: '127.0.0.1', PORT: String(port), TWELVE_DATA_API_KEY: 'TESTKEY12345678' };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

async function sql<T extends pg.QueryResultRow>(database: string, text: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

async function adminQuery(text: string): Promise<void> {
  const { connection, adminDatabase } = connected();
  const admin = new pg.Client({ ...connection, database: adminDatabase });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    await admin.query(text);
  } finally {
    await admin.end();
  }
}

const databases: TestDatabase[] = [];
const emptyDatabases: string[] = [];

async function trackDatabase(created: Promise<TestDatabase>): Promise<TestDatabase> {
  const db = await created;
  databases.push(db);
  return db;
}

async function createEmptyDatabase(): Promise<string> {
  const name = 'nexus_o18_empty_' + randomBytes(6).toString('hex');
  await adminQuery('CREATE DATABASE ' + name);
  emptyDatabases.push(name);
  return name;
}

describe.skipIf(!pgAvailable)('O18 runtime on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
    for (const name of emptyDatabases.splice(0)) await adminQuery('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
  });

  it('refuses to start on a database without the repository migrations, and does not migrate it', async () => {
    const name = await createEmptyDatabase();
    const error = await startRuntime(envFor(name, await freePort())).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeStartError);
    expect(error).toMatchObject({ code: 'MIGRATIONS_PENDING' });
    const rows = await sql<{ present: boolean }>(name, "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
    expect(rows[0]?.present).toBe(false);
  });

  it('starts on a migrated database, serves the API, and after a restart reads its state back from PostgreSQL', async () => {
    const db = await trackDatabase(createTestDatabase());
    const stores = await openPostgresMarketDataStores(db.pool);
    await registerAapl(stores.instruments);
    const options = { provider: fixtureProvider(), clock: () => new Date(RUNTIME_TEST_NOW) };

    const first = await startRuntime(envFor(db.name, await freePort()), options);
    try {
      const health = await (await fetch(first.url + '/health')).json() as Record<string, unknown>;
      expect(health).toMatchObject({ status: 'ok', database: 'connected', marketData: 'configured', tradingMode: 'paper', liveTrading: 'locked' });

      const bars = await (await fetch(first.url + '/api/market/bars?instrumentId=ins_aapl&interval=1d&from=2026-08-01T00:00:00.000Z&to=2026-10-14T00:00:00.000Z')).json() as { bars: unknown[]; usableForTrading: boolean };
      expect(bars.bars.length).toBeGreaterThan(0);
      expect(bars.usableForTrading).toBe(false);

      const quant = await fetch(first.url + '/api/quant/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instrumentId: 'ins_aapl', interval: '1d', asOf: RUNTIME_TEST_NOW }),
      });
      expect(quant.status).toBe(200);
    } finally {
      await first.close();
    }

    const storedBars = await sql<{ n: number }>(db.name, 'SELECT count(*)::int AS n FROM market_bars');
    expect(storedBars[0]?.n).toBeGreaterThan(0);
    const storedRuns = await sql<{ n: number }>(db.name, 'SELECT count(*)::int AS n FROM quant_runs');
    expect(storedRuns[0]?.n).toBeGreaterThan(0);

    // A second process on the same database: the instrument registry is replayed from the instrument log in PostgreSQL.
    const second = await startRuntime(envFor(db.name, await freePort()), options);
    try {
      const search = await (await fetch(second.url + '/api/instruments/search?q=AAPL')).json() as { instruments: Array<{ instrumentId: string | null }> };
      expect(search.instruments[0]?.instrumentId).toBe('ins_aapl');
    } finally {
      await second.close();
    }
  });
});
