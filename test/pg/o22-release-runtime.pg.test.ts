// O22 B1 release over the REAL entry path, WITHOUT any mock of the lock: configuration from the environment, PostgreSQL, startRuntime
// (bootstrap and composition as in production), the HTTP routes and operator authentication. Only the outside world is simulated:
// the market data provider (a production-labelled fixture quote), the read-only eToro transport (portfolio and /demo/pnl answers)
// and the demo execution transport (a scripted broker). Nothing reaches the network.
//   1. Default: without ETORO_DEMO_EXECUTION_ENABLED the release build opens no execution log, every intent route is EXECUTION_DISABLED,
//      the cycle route reports execution disabled, and no broker write is possible.
//   2. Enabled (ETORO_DEMO_EXECUTION_ENABLED=1): the one open goes through the real routes exactly once to the demo endpoint; the
//      budget then refuses a second open; operator authentication is still required; nothing secret is stored.
import { createServer } from 'node:net';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_LOCKS } from '../../src/nexus/safety.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import type { MarketDataProvider } from '../../src/market-data/market-data-provider.js';
import type { MarketDataSource, MarketQuote } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { PostgresAppendOnlyStore } from '../../src/persistence/postgres/postgres-append-only-store.js';
import { PostgresLedgerStore } from '../../src/persistence/postgres/postgres-ledger-store.js';
import type { EtoroOperation } from '../../src/broker/etoro/etoro-readonly.js';
import type { EtoroResponse, EtoroTransport } from '../../src/broker/etoro/etoro-transport.js';
import { HttpsDemoExecutionTransport } from '../../src/broker/etoro/execution/etoro-demo-execution-transport.js';
import { startRuntime } from '../../src/runtime/bootstrap.js';
import { AAPL } from '../market-data/fixtures.js';
import { emptyDemoPortfolio } from '../broker/etoro/o20-fixture.js';
import { schemaPnl } from '../broker/etoro/o21a1-pnl-fixture.js';
import { API_KEY_MARKER, ETORO_AAPL_ID, O21_NOW, ScriptedBroker, USER_KEY_MARKER, openInput, orderAccepted } from '../broker/etoro/o21-fixture.js';
import { createTestDatabase, pgAvailable, pgInfo, pgSkipReason, type TestDatabase } from './db.js';

const OPERATOR_TOKEN = 'O22-RELEASE-PG-OPERATOR-TOKEN-0123456789abcdef';
const TWELVE_DATA_KEY_MARKER = 'O22RELEASETWELVEDATAKEYMARKER0001';
const NOW_MS = Date.parse(O21_NOW);

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

/** The read-only eToro transport: an empty demo portfolio for the sync, an empty valued account (NORMAL) for /demo/pnl. */
class ReadOnlyFixture implements EtoroTransport {
  readonly calls: EtoroOperation[] = [];
  async call(operation: EtoroOperation): Promise<EtoroResponse> {
    this.calls.push(operation);
    if (operation === 'portfolio.demo') return { status: 200, body: emptyDemoPortfolio() };
    if (operation === 'pnl.demo') return { status: 200, body: schemaPnl() };
    return { status: 404, body: null };
  }
}

const QUOTE_SOURCE: MarketDataSource = { sourceId: 'twelvedata:quote:production', provider: 'twelvedata', dataset: 'quote', environment: 'production', license: 'unreviewed', licenseNote: 'O22 release test fixture' };

/** A market data provider fixture: one fresh, production-labelled USD quote (10 s old at the runtime clock). No network. */
function quoteProvider(): MarketDataProvider {
  return {
    providerId: 'twelvedata',
    searchInstruments: async () => [],
    getInstrument: async () => null,
    getHistoricalBars: async () => {
      throw new Error('bars are not part of this test');
    },
    getQuote: async (request) => {
      const observedAt = new Date(NOW_MS - 10_000).toISOString();
      const quote: MarketQuote = {
        instrumentId: request.instrument.instrumentId,
        source: QUOTE_SOURCE.sourceId,
        last: Decimal.from('200'),
        currency: 'USD',
        marketOpen: true,
        observedAt,
        availableAt: O21_NOW,
        retrievedAt: O21_NOW,
      };
      return { source: QUOTE_SOURCE, quote };
    },
    health: () => ({ provider: 'twelvedata', state: 'closed', consecutiveFailures: 0 }),
  };
}

/** The governed registry as the operator prepared it: the instrument, its Twelve Data mapping and the human eToro mapping. */
async function prepareRegistry(db: TestDatabase): Promise<void> {
  const clock = () => new Date('2026-10-01T00:00:00.000Z');
  const registry = await InstrumentRegistry.open(await PostgresAppendOnlyStore.open<InstrumentEvent>(db.pool, 'instruments'), { clock });
  const change = { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human' as const, id: 'mapping-owner' }, reason: 'O22 release test: governed mappings' };
  await registry.register({ ...AAPL }, change);
  await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '2026-10-01T00:00:00.000Z' }, change);
  await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'etoro', providerSymbol: String(ETORO_AAPL_ID), validFrom: '2026-10-01T00:00:00.000Z' }, change);
}

function routeIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { createdBy: _ignored, ...intent } = openInput({ amount: '100', ...overrides });
  void _ignored;
  return intent;
}

const databases: TestDatabase[] = [];

describe.skipIf(!pgAvailable)('O22 B1 release over the real entry path (no mock of the lock)' + (pgAvailable ? '' : ' (NOT RUN: ' + pgSkipReason + ')'), () => {
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.drop();
  });

  it('the build really opens only the demo lock', () => {
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: false });
  });

  it('default (ETORO_DEMO_EXECUTION_ENABLED not set): execution disabled end to end; no execution log, no broker write', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    await PostgresLedgerStore.open(db.pool, { ledgerId: 'main' });
    const broker = new ScriptedBroker();
    const runtime = await startRuntime(
      {
        DATABASE_URL: urlFor(db.name), HOST: '127.0.0.1', PORT: String(await freePort()),
        ETORO_ENABLED: '1', ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: API_KEY_MARKER, ETORO_USER_KEY: USER_KEY_MARKER,
        NEXUS_OPERATOR_ID: 'operator-release', NEXUS_OPERATOR_TOKEN: OPERATOR_TOKEN,
      },
      {
        provider: null,
        etoroTransport: new ReadOnlyFixture(),
        // Passed on purpose: the bootstrap must not even build the execution wiring without the flag.
        etoroExecutionTransport: new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, fetch: broker.fetch }),
        clock: () => new Date(O21_NOW),
      },
    );
    try {
      expect(runtime.config).toMatchObject({ etoroDemoExecution: 'disabled', tradingMode: 'paper', liveTrading: 'locked' });
      const health = (await (await fetch(runtime.url + '/api/health')).json()) as { buildLocks: Record<string, boolean> };
      expect(health.buildLocks).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: false });
      const headers = { authorization: 'Bearer ' + OPERATOR_TOKEN, 'content-type': 'application/json' };
      const create = await fetch(runtime.url + '/api/broker/etoro/demo/intents', { method: 'POST', headers, body: JSON.stringify(routeIntent()) });
      expect(create.status).toBe(403);
      expect(((await create.json()) as { error: { code: string } }).error.code).toBe('EXECUTION_DISABLED');
      const execute = await fetch(runtime.url + '/api/broker/etoro/demo/intents/eint_' + 'f'.repeat(40) + '/execute', { method: 'POST', headers });
      expect(((await execute.json()) as { error: { code: string } }).error.code).toBe('EXECUTION_DISABLED');
      const cycle = (await (await fetch(runtime.url + '/api/broker/etoro/demo/cycle')).json()) as { cycle: Record<string, unknown> };
      expect(cycle.cycle).toMatchObject({ execution: 'disabled', buildLocked: false, budget: null, test: null });
      expect(broker.requests).toEqual([]);
    } finally {
      await runtime.close();
    }
    expect(await rows(db.name, "SELECT count(*)::int AS n FROM append_only_logs WHERE log_name LIKE 'etoro-demo-%'")).toEqual([{ n: 0 }]);
  });

  it('enabled: through the real routes exactly one open goes to the demo endpoint; the budget refuses a second; auth still required', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    await PostgresLedgerStore.open(db.pool, { ledgerId: 'main' });
    await prepareRegistry(db);
    const broker = new ScriptedBroker();
    const readOnly = new ReadOnlyFixture();
    const runtime = await startRuntime(
      {
        DATABASE_URL: urlFor(db.name), HOST: '127.0.0.1', PORT: String(await freePort()),
        TWELVE_DATA_API_KEY: TWELVE_DATA_KEY_MARKER,
        ETORO_ENABLED: '1', ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: API_KEY_MARKER, ETORO_USER_KEY: USER_KEY_MARKER,
        ETORO_DEMO_EXECUTION_ENABLED: '1',
        NEXUS_OPERATOR_ID: 'operator-release', NEXUS_OPERATOR_TOKEN: OPERATOR_TOKEN,
      },
      {
        provider: quoteProvider(),
        etoroTransport: readOnly,
        etoroExecutionTransport: new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, fetch: broker.fetch }),
        clock: () => new Date(O21_NOW),
      },
    );
    const responses: string[] = [];
    const call = async (method: string, path: string, body?: unknown, auth = true) => {
      const headers: Record<string, string> = { ...(auth ? { authorization: 'Bearer ' + OPERATOR_TOKEN } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
      const res = await fetch(runtime.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      responses.push(text);
      return { status: res.status, json: JSON.parse(text) as Record<string, any> };
    };
    let openId = '';
    try {
      expect(runtime.config).toMatchObject({ etoroDemoExecution: 'enabled', marketData: 'production', operatorAuth: 'configured', tradingMode: 'paper', liveTrading: 'locked' });
      expect((await call('POST', '/api/broker/etoro/sync', undefined, false)).status).toBe(200);
      const quote = await call('GET', '/api/market/quote?instrumentId=' + AAPL.instrumentId, undefined, false);
      expect(quote.json).toMatchObject({ currency: 'USD', source: 'twelvedata:quote:production', usableForTrading: true });

      // Operator authentication is still required.
      expect((await call('POST', '/api/broker/etoro/demo/intents', routeIntent(), false)).json.error.code).toBe('OPERATOR_AUTH_REQUIRED');

      const created = await call('POST', '/api/broker/etoro/demo/intents', routeIntent());
      expect(created.status).toBe(201);
      expect(created.json.intent.gateReasons).toEqual([]);
      expect(created.json.intent.state).toBe('RISK_APPROVED');
      openId = created.json.intent.intentId;
      expect((await call('POST', '/api/broker/etoro/demo/intents/' + openId + '/approve')).json.intent.state).toBe('APPROVED');
      broker.next(orderAccepted());
      const executed = await call('POST', '/api/broker/etoro/demo/intents/' + openId + '/execute');
      expect(executed.json.intent.state).toBe('SUBMITTED');
      expect(broker.writes.map((w) => w.method + ' ' + w.url)).toEqual(['POST https://public-api.etoro.com/api/v2/trading/execution/demo/orders']);
      expect(broker.writes[0]!.body).toMatchObject({ action: 'open', transaction: 'buy', instrumentId: ETORO_AAPL_ID, orderType: 'mkt', amount: 100, leverage: 1 });

      // A second open: refused by the cycle budget; nothing more is sent.
      const second = await call('POST', '/api/broker/etoro/demo/intents', routeIntent({ strategyRunId: 'run-release-second', createdAt: '2026-10-16T13:59:30.000Z' }));
      expect(second.json.intent.state).toBe('REJECTED');
      expect(second.json.intent.gateReasons).toContain('CYCLE_OPEN_BUDGET_EXHAUSTED');
      const cycle = await call('GET', '/api/broker/etoro/demo/cycle', undefined, false);
      expect(cycle.json.cycle).toMatchObject({ execution: 'enabled', buildLocked: false, budget: { openSubmissions: 1, closeSubmissions: 0, maxOpenSubmissions: 1, maxCloseSubmissions: 1 } });
      expect(broker.writes).toHaveLength(1);
      expect(readOnly.calls.filter((c) => c !== 'portfolio.demo' && c !== 'pnl.demo')).toEqual([]);
    } finally {
      await runtime.close();
    }

    expect(await rows(db.name, 'SELECT count(*)::int AS n FROM ledger_transactions')).toEqual([{ n: 0 }]);
    const tables = (await rows(db.name, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).map((r) => String(r.table_name));
    let everything = responses.join('\n');
    for (const table of tables) everything += JSON.stringify(await rows(db.name, 'SELECT row_to_json(t)::text AS j FROM "' + table + '" t'));
    expect(everything).toContain(openId);
    for (const secret of [API_KEY_MARKER, USER_KEY_MARKER, OPERATOR_TOKEN, TWELVE_DATA_KEY_MARKER]) expect(everything).not.toContain(secret);
    // Its own limit: a full runtime start, a quote ingest and a scan of every table take about 10 s alone, but exceeded the global 60 s
    // when the whole pg project ran in parallel (observed 20.10.2026). The assertions are unchanged.
  }, 180_000);
});
