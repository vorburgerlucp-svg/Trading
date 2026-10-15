// The IBKR read-only path against a real PostgreSQL, through the production start (startRuntime) with the fixture gateway:
// start, sync, explicit mapping, sync again, restart, read back. The Capital Ledger, the kill switch and the broker order
// surface are checked in the database itself, not only through the API.
import { createServer } from 'node:net';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { startRuntime, type RuntimeHandle } from '../../src/runtime/bootstrap.js';
import { openPostgresMarketDataStores } from '../../src/persistence/postgres/postgres-stores.js';
import { InstrumentRegistry } from '../../src/market-data/instrument-registry.js';
import { AAPL } from '../market-data/fixtures.js';
import { FixtureIbkrReadOnlyAdapter, FIXTURE_CONID_AAPL, FIXTURE_SESSION_TOKEN, FIXTURE_ACCOUNT } from '../broker/ibkr/o19-fixture.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

const T0 = '2026-10-15T09:00:00.000Z';
const change = { at: T0, by: { kind: 'human' as const, id: 'o19-pg' }, reason: 'o19 pg fixture' };

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

function urlFor(database: string): string {
  if (!pgInfo.available) throw new Error(pgSkipReason);
  const { connection } = pgInfo;
  return 'postgres://' + encodeURIComponent(connection.user) + ':' + encodeURIComponent(connection.password) + '@' + connection.host + ':' + connection.port + '/' + database;
}

async function countOf(database: string, sql: string, values: unknown[] = []): Promise<number> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return Number((await client.query<{ n: string }>(sql, values)).rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const response = await fetch(base + path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const runtimes: RuntimeHandle[] = [];
const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const db of databases.splice(0)) await db.drop();
});

describe.skipIf(!pgAvailable)('O19 IBKR read-only path on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  it('an enabled IBKR with an unreadable gateway certificate path does not start: the start stops with a fixed code', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const env = { DATABASE_URL: urlFor(db.name), HOST: '127.0.0.1', PORT: String(await freePort()), IBKR_ENABLED: '1', IBKR_CA_CERT_PATH: 'C:/does/not/exist/gateway.pem' };
    const error = await startRuntime(env, { clock: () => new Date(T0) }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'IBKR_CA_UNREADABLE' });
    expect(String((error as Error).message)).not.toContain('gateway.pem');
  });

  it('start, sync, map, sync, restart and read back: the ledger, the kill switch and the order surface are untouched', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const stores = await openPostgresMarketDataStores(db.pool);
    const registry = await InstrumentRegistry.open(stores.instruments);
    await registry.register({ ...AAPL }, change);

    const fixture = new FixtureIbkrReadOnlyAdapter();
    const env = { DATABASE_URL: urlFor(db.name), HOST: '127.0.0.1', PORT: String(await freePort()), IBKR_ENABLED: '1', IBKR_ACCOUNT_ID: FIXTURE_ACCOUNT };
    // A movable clock: the account list is paced at one request per five seconds, so later syncs must come after that window.
    let now = Date.parse(T0);
    const options = { ibkrTransport: fixture, clock: () => new Date(now) };

    const first = await startRuntime(env, options);
    runtimes.push(first);
    const sync = await call(first.url, 'POST', '/api/broker/ibkr/sync');
    expect(sync.status).toBe(200);
    expect(sync.text).toContain('unmapped_broker_instrument');
    const mapped = await call(first.url, 'POST', '/api/broker/ibkr/mappings', { conid: FIXTURE_CONID_AAPL, instrumentId: AAPL.instrumentId, validFrom: '1980-12-12T00:00:00.000Z' });
    expect(mapped).toMatchObject({ status: 200, json: { status: 'MAPPED', instrumentId: 'ins_aapl' } });
    now += 10_000;
    const afterMapping = await call(first.url, 'POST', '/api/broker/ibkr/sync');
    expect(afterMapping.status).toBe(200);
    expect(afterMapping.text).not.toContain('unmapped_broker_instrument');
    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    // Everything below is read back from PostgreSQL by a fresh process. The unmapped and the mapped state are two different
    // snapshots (the mapping is part of the observed content); two observations of the mapped state come after the mapping.
    expect(await countOf(db.name, "SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'broker-snapshots'")).toBe(2);
    expect(await countOf(db.name, "SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'broker-sync-events'")).toBe(2);
    expect(await countOf(db.name, "SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'broker-reconciliations'")).toBeGreaterThan(0);
    const stored = await countOf(db.name, "SELECT count(*)::int AS n FROM append_only_records WHERE payload::text LIKE '%" + FIXTURE_ACCOUNT + "%' OR payload::text LIKE '%" + FIXTURE_SESSION_TOKEN + "%'");
    expect(stored).toBe(0);

    const ledgerBefore = await countOf(db.name, 'SELECT count(*)::int AS n FROM ledger_transactions');
    const killSwitchBefore = await countOf(db.name, "SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'portfolio-kill-switch'");

    const second = await startRuntime(env, options);
    runtimes.push(second);
    const snapshot = await call(second.url, 'GET', '/api/broker/ibkr/snapshot');
    expect(snapshot.json).toMatchObject({ snapshot: { content: { accountRef: 'U****567' } } });
    expect(snapshot.text).toContain('ins_aapl');
    expect(snapshot.text).not.toContain(FIXTURE_ACCOUNT);
    const reconciliation = await call(second.url, 'GET', '/api/broker/ibkr/reconciliation');
    expect(reconciliation.json).toMatchObject({ reconciliation: { snapshotId: (snapshot.json.snapshot as { snapshotId: string }).snapshotId } });

    // An identical state observed again adds an observation, never a third snapshot.
    await call(second.url, 'POST', '/api/broker/ibkr/sync');
    expect(await countOf(db.name, "SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'broker-snapshots'")).toBe(2);

    expect(await countOf(db.name, 'SELECT count(*)::int AS n FROM ledger_transactions')).toBe(ledgerBefore);
    expect(await countOf(db.name, "SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'portfolio-kill-switch'")).toBe(killSwitchBefore);
    expect((await call(second.url, 'POST', '/api/broker/place', {})).status).toBe(404);
    expect((await call(second.url, 'POST', '/api/broker/ibkr/order', {})).status).toBe(404);
  });
});
