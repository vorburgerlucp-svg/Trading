// O21 over the real entry path: configuration from the environment, PostgreSQL, startRuntime. With ETORO_DEMO_EXECUTION_ENABLED=1
// the intent routes exist and persist append-only in PostgreSQL; the production composition has no eToro demo safety source, so an
// open is refused; and BUILD_LOCKS.etoroDemoExecution refuses every write. No broker request is made. Transports are fixtures.
import { createServer } from 'node:net';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresLedgerStore } from '../../src/persistence/postgres/postgres-ledger-store.js';
import { HttpsDemoExecutionTransport } from '../../src/broker/etoro/execution/etoro-demo-execution-transport.js';
import { startRuntime } from '../../src/runtime/bootstrap.js';
import { FixtureEtoroTransport } from '../broker/etoro/o20-fixture.js';
import { API_KEY_MARKER, O21_NOW, ScriptedBroker, USER_KEY_MARKER, openInput } from '../broker/etoro/o21-fixture.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

function urlFor(database: string): string {
  if (!pgInfo.available) throw new Error(pgSkipReason);
  const { connection } = pgInfo;
  return 'postgres://' + encodeURIComponent(connection.user) + ':' + encodeURIComponent(connection.password) + '@' + connection.host + ':' + connection.port + '/' + database;
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

async function rows(database: string, text: string): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return (await client.query(text)).rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

const databases: TestDatabase[] = [];
const OPERATOR_TOKEN = 'O21-PG-OPERATOR-TOKEN-0123456789abcdef-xyz';

/** The route takes the intent without createdBy: the creator is the authenticated operator. Since O22 the runtime cycle policy caps an open at 100 USD. */
function routeIntent(): Record<string, unknown> {
  const { createdBy: _ignored, ...intent } = openInput({ amount: '100' });
  void _ignored;
  return intent;
}

describe.skipIf(!pgAvailable)('O21 runtime on PostgreSQL' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  it('enabled by the environment, persisted in PostgreSQL, and locked in build: 0 broker requests', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    await PostgresLedgerStore.open(db.pool, { ledgerId: 'main' });
    const broker = new ScriptedBroker();
    const readOnly = new FixtureEtoroTransport();
    const env = {
      DATABASE_URL: urlFor(db.name),
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
      ETORO_ENABLED: '1',
      ETORO_TRADING_MODE: 'demo',
      ETORO_API_KEY: API_KEY_MARKER,
      ETORO_USER_KEY: USER_KEY_MARKER,
      ETORO_DEMO_EXECUTION_ENABLED: '1',
      NEXUS_OPERATOR_ID: 'operator-pg',
      NEXUS_OPERATOR_TOKEN: OPERATOR_TOKEN,
    };
    const runtime = await startRuntime(env, {
      provider: null,
      etoroTransport: readOnly,
      etoroExecutionTransport: new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, fetch: broker.fetch }),
      clock: () => new Date(O21_NOW),
    });
    const responses: string[] = [];
    const post = async (path: string, body?: unknown, auth = true) => {
      const headers: Record<string, string> = { ...(auth ? { authorization: 'Bearer ' + OPERATOR_TOKEN } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
      const res = await fetch(runtime.url + path, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      responses.push(text);
      return { status: res.status, json: JSON.parse(text) as Record<string, any> };
    };
    let intentId = '';
    try {
      expect(runtime.config).toMatchObject({ etoro: 'demo_read_only', etoroDemoExecution: 'enabled', operatorAuth: 'configured', tradingMode: 'paper', liveTrading: 'locked' });
      expect((await post('/api/broker/etoro/sync', undefined, false)).status).toBe(200);
      expect((await post('/api/broker/etoro/demo/intents', routeIntent(), false)).json.error.code).toBe('OPERATOR_AUTH_REQUIRED');

      const created = await post('/api/broker/etoro/demo/intents', routeIntent());
      expect(created.status).toBe(201);
      expect(created.json.intent.state).toBe('REJECTED');
      // O22: the demo account safety source is wired and its evidence is recorded, so it reads /demo/pnl once. The fixture answers
      // with a portfolio body without accountCurrencyId: the valuation is a DATA_HOLD (never read as USD), which blocks the open.
      expect(created.json.intent.gateReasons).toContain('PORTFOLIO_SAFETY_BLOCKS_RISK_INCREASE');
      expect(created.json.intent.gateReasons).not.toContain('PORTFOLIO_SAFETY_NOT_CONNECTED');
      expect(readOnly.calls).toEqual(['portfolio.demo', 'pnl.demo']);
      expect(created.json.intent.intent.createdBy).toEqual({ kind: 'human', id: 'operator-pg' });
      intentId = created.json.intent.intentId;

      expect((await post('/api/broker/etoro/demo/intents/' + intentId + '/execute')).json.error.code).toBe('EXECUTION_LOCKED_IN_BUILD');
      expect((await post('/api/broker/etoro/demo/intents/' + intentId + '/cancel')).json.error.code).toBe('EXECUTION_LOCKED_IN_BUILD');
      expect(broker.requests).toHaveLength(0);
    } finally {
      await runtime.close();
    }

    const logs = await rows(db.name, "SELECT log_name, (SELECT count(*)::int FROM append_only_records r WHERE r.log_name = l.log_name) AS n FROM append_only_logs l WHERE log_name LIKE 'etoro-demo-%' ORDER BY 1");
    expect(logs).toEqual([
      // O22: the demo account safety source is wired; without released evidence it reads nothing and records no valuation.
      { log_name: 'etoro-demo-account-valuations', n: 0 },
      { log_name: 'etoro-demo-broker-confirmations', n: 0 },
      { log_name: 'etoro-demo-execution-attempts', n: 0 },
      { log_name: 'etoro-demo-execution-intents', n: 2 },
      { log_name: 'etoro-demo-execution-reconciliations', n: 0 },
    ]);
    expect(await rows(db.name, 'SELECT count(*)::int AS n FROM ledger_transactions')).toEqual([{ n: 0 }]);
    expect(await rows(db.name, "SELECT count(*)::int AS n FROM append_only_records WHERE log_name = 'portfolio-kill-switch'")).toEqual([{ n: 0 }]);

    const tables = (await rows(db.name, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).map((r) => String(r.table_name));
    let everything = responses.join('\n');
    for (const table of tables) everything += JSON.stringify(await rows(db.name, 'SELECT row_to_json(t)::text AS j FROM "' + table + '" t'));
    expect(everything).toContain(intentId);
    expect(everything).not.toContain(API_KEY_MARKER);
    expect(everything).not.toContain(USER_KEY_MARKER);
    expect(everything).not.toContain(OPERATOR_TOKEN);
    expect(everything.toLowerCase()).not.toContain('x-api-key');
  });

  it('without ETORO_DEMO_EXECUTION_ENABLED the execution logs are not even opened', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    await PostgresLedgerStore.open(db.pool, { ledgerId: 'main' });
    const runtime = await startRuntime(
      { DATABASE_URL: urlFor(db.name), HOST: '127.0.0.1', PORT: String(await freePort()), ETORO_ENABLED: '1', ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: API_KEY_MARKER, ETORO_USER_KEY: USER_KEY_MARKER },
      { provider: null, etoroTransport: new FixtureEtoroTransport(), clock: () => new Date(O21_NOW) },
    );
    try {
      expect(runtime.config.etoroDemoExecution).toBe('disabled');
      const res = await fetch(runtime.url + '/api/broker/etoro/demo/intents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(routeIntent()) });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('EXECUTION_DISABLED');
    } finally {
      await runtime.close();
    }
    expect(await rows(db.name, "SELECT count(*)::int AS n FROM append_only_logs WHERE log_name LIKE 'etoro-demo-%'")).toEqual([{ n: 0 }]);
  });
});
