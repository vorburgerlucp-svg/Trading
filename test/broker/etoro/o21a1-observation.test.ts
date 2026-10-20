// O21A.1: the pnl.demo transport operation, the mandatory --source of the observation tool (exactly one request per invocation, no
// default, no fallback, no retry), and the pnl schema report, which describes the live shape independently of the parser verdict.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrokerError } from '../../../src/broker/broker-errors.js';
import { CONFIRM_FLAG, runObservation } from '../../../src/broker/etoro/etoro-observe-cli.js';
import { observeDemoPortfolio, observeDemoResponse } from '../../../src/broker/etoro/etoro-observation.js';
import { ETORO_ALLOWED_OPERATIONS, ETORO_BASE_URL, type EtoroOperation } from '../../../src/broker/etoro/etoro-readonly.js';
import { HttpsEtoroTransport, type EtoroFetch } from '../../../src/broker/etoro/etoro-transport.js';
import { BUILD_LOCKS } from '../../../src/nexus/safety.js';
import { FixtureEtoroTransport, KEY_MARKER, USER_MARKER, emptyDemoPortfolio } from './o20-fixture.js';
import { documentedPortfolio } from './o21a-documented-fixture.js';
import { referenceExamplePnlPosition, schemaPnl, schemaPnlOrder, schemaPnlOrderForOpen, schemaPnlPosition } from './o21a1-pnl-fixture.js';

const SALT = Buffer.alloc(32, 3);
const ENV = { ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: KEY_MARKER, ETORO_USER_KEY: USER_MARKER };
const PNL_URL = 'https://public-api.etoro.com/api/v1/trading/info/demo/pnl';
const PORTFOLIO_URL = 'https://public-api.etoro.com/api/v1/trading/info/demo/portfolio';

/** A fetch that records every request and answers each with the given status and body. */
function recordingFetch(answer: { status: number; body?: unknown }) {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetch: EtoroFetch = async (url, init) => {
    requests.push({ url, method: String(init.method), body: init.body });
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
  return { requests, transport: (credentials: { apiKey: string; userKey: string }) => new HttpsEtoroTransport({ credentials, fetch }) };
}

describe('O21A.1 transport: fixed GET operations only (two demo account reads, and since O22 one fixed market-data read)', () => {
  it('pnl.demo is GET /trading/info/demo/pnl, portfolio.demo is unchanged, and O22 added exactly one fixed instrument metadata read and the identity read', () => {
    expect(ETORO_ALLOWED_OPERATIONS).toEqual({
      'portfolio.demo': { method: 'GET', path: '/trading/info/demo/portfolio' },
      'pnl.demo': { method: 'GET', path: '/trading/info/demo/pnl' },
      'instrument.metadata.100001': { method: 'GET', base: 'https://public-api.etoro.com/api/v2', path: '/market-data/instruments?instrumentsIds=100001' },
      'identity.me': { method: 'GET', path: '/me' },
    });
    expect(Object.isFrozen(ETORO_ALLOWED_OPERATIONS)).toBe(true);
    for (const spec of Object.values(ETORO_ALLOWED_OPERATIONS)) expect(spec.path).not.toMatch(/real|order|execution|close|cancel/i);
  });

  it('the transport sends pnl.demo as one GET to the fixed URL, with no body', async () => {
    const r = recordingFetch({ status: 200, body: schemaPnl() });
    await r.transport({ apiKey: KEY_MARKER, userKey: USER_MARKER }).call('pnl.demo');
    expect(r.requests).toEqual([{ url: ETORO_BASE_URL + '/trading/info/demo/pnl', method: 'GET', body: undefined }]);
    expect(r.requests[0]?.url).toBe(PNL_URL);
  });

  it('an unknown operation is refused before any request', async () => {
    const r = recordingFetch({ status: 200, body: {} });
    for (const op of ['pnl.real', 'portfolio.real', 'order.demo', 'pnl']) {
      await expect(r.transport({ apiKey: KEY_MARKER, userKey: USER_MARKER }).call(op as EtoroOperation)).rejects.toBeInstanceOf(BrokerError);
    }
    expect(r.requests).toEqual([]);
  });

  it('the sync adapter and the runtime never call pnl.demo: only the observation tool and, since O22, the demo account safety source do', () => {
    const files = ['src/broker/etoro', 'src/broker/etoro/execution', 'src/runtime'].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)));
    const users = files.filter((f) => readFileSync(f, 'utf8').includes("'pnl.demo'")).map((f) => f.replace(/\\/g, '/'));
    expect(users.sort()).toEqual(['src/broker/etoro/etoro-observe-cli.ts', 'src/broker/etoro/etoro-readonly.ts', 'src/broker/etoro/execution/demo-account-safety.ts']);
  });
});

describe('O21A.1 observation tool: --source is mandatory, one request per invocation', () => {
  const refusals: Array<[string, string[]]> = [
    ['no --source', [CONFIRM_FLAG]],
    ['an invalid source', ['--source=real', CONFIRM_FLAG]],
    ['an empty source', ['--source=', CONFIRM_FLAG]],
    ['two sources', ['--source=portfolio', '--source=pnl', CONFIRM_FLAG]],
    ['the same source twice', ['--source=pnl', '--source=pnl', CONFIRM_FLAG]],
    ['--source without =', ['--source', 'pnl', CONFIRM_FLAG]],
    ['no --confirm-live-read', ['--source=pnl']],
  ];
  for (const [name, argv] of refusals) {
    it(`${name}: refused, no transport built, no request`, async () => {
      let built = 0;
      const outcome = await runObservation({ env: ENV, argv, transport: () => ((built++), new FixtureEtoroTransport()) });
      expect(outcome.exitCode).toBe(2);
      expect(built).toBe(0);
    });
  }

  it('source=portfolio: exactly one GET of the demo portfolio, nothing else', async () => {
    const r = recordingFetch({ status: 200, body: emptyDemoPortfolio() });
    const outcome = await runObservation({ env: ENV, argv: ['--source=portfolio', CONFIRM_FLAG], transport: r.transport });
    expect(outcome).toMatchObject({ exitCode: 0, report: { source: 'portfolio', endpoint: 'GET /api/v1/trading/info/demo/portfolio' } });
    expect(r.requests.map((q) => [q.method, q.url])).toEqual([['GET', PORTFOLIO_URL]]);
  });

  it('source=pnl: exactly one GET of the demo pnl, nothing else', async () => {
    const r = recordingFetch({ status: 200, body: schemaPnl() });
    const outcome = await runObservation({ env: ENV, argv: ['--source=pnl', CONFIRM_FLAG], transport: r.transport });
    expect(outcome).toMatchObject({ exitCode: 0, report: { source: 'pnl', endpoint: 'GET /api/v1/trading/info/demo/pnl' } });
    expect(r.requests.map((q) => [q.method, q.url])).toEqual([['GET', PNL_URL]]);
  });

  it('no fallback: an empty portfolio does not trigger a pnl read, an empty pnl does not trigger a portfolio read', async () => {
    const t = new FixtureEtoroTransport();
    t.response = { status: 200, body: emptyDemoPortfolio() };
    await runObservation({ env: ENV, argv: ['--source=portfolio', CONFIRM_FLAG], transport: () => t });
    expect(t.calls).toEqual(['portfolio.demo']);
    const u = new FixtureEtoroTransport();
    u.response = { status: 200, body: schemaPnl() };
    await runObservation({ env: ENV, argv: ['--source=pnl', CONFIRM_FLAG], transport: () => u });
    expect(u.calls).toEqual(['pnl.demo']);
  });

  for (const status of [401, 403, 404, 429, 500, 503]) {
    it(`HTTP ${status} on pnl fails closed with the status only, after exactly one request (no retry)`, async () => {
      const r = recordingFetch({ status, body: { secret: 'ERROR-BODY-VALUE' } });
      const outcome = await runObservation({ env: ENV, argv: ['--source=pnl', CONFIRM_FLAG], transport: r.transport });
      expect(outcome).toEqual({ exitCode: 1, error: 'broker returned HTTP ' + status });
      expect(r.requests).toHaveLength(1);
    });
  }

  it('a network failure is one request and a fixed code, never the error text or a key', async () => {
    let requests = 0;
    const fetch: EtoroFetch = async () => {
      requests++;
      throw new Error('ECONNRESET ' + KEY_MARKER);
    };
    const outcome = await runObservation({ env: ENV, argv: ['--source=pnl', CONFIRM_FLAG], transport: (credentials) => new HttpsEtoroTransport({ credentials, fetch }) });
    expect(outcome).toEqual({ exitCode: 1, error: 'BROKER_NOT_CONNECTED' });
    expect(requests).toBe(1);
  });

  it('no key, header or value in the pnl outcome', async () => {
    const r = recordingFetch({ status: 200, body: schemaPnl({ positions: [schemaPnlPosition()] }) });
    const text = JSON.stringify(await runObservation({ env: ENV, argv: ['--source=pnl', CONFIRM_FLAG, '--pseudonymize-ids'], transport: r.transport }));
    expect(text).not.toContain(KEY_MARKER);
    expect(text).not.toContain(USER_MARKER);
    expect(text).not.toMatch(/x-api-key|x-user-key|authorization/i);
    for (const value of ['2150896073', '7765437', '10000.5', '100.25', '2024-08-01']) expect(text).not.toContain(value);
  });
});

describe('O21A.1 observation report: pnl', () => {
  it('an empty pnl: every schema container reported, nothing missing, parser accepted', () => {
    const report = observeDemoResponse('pnl', schemaPnl(), { salt: SALT });
    expect(report.source).toBe('pnl');
    expect(report.clientPortfolio.undocumentedKeys).toEqual([]);
    expect(report.clientPortfolio.documentedMissing).toEqual(['stockOrders', 'entryOrders', 'exitOrders']);
    for (const c of ['positions', 'orders', 'ordersForOpen', 'ordersForClose', 'ordersForCloseMultiple', 'mirrors']) expect(report.containers[c]).toMatchObject({ kind: 'array', count: 0, documented: 'element_schema' });
    expect(report.parser).toEqual({ outcome: 'accepted', positions: 0, orders: 0, ordersForOpen: 0 });
  });

  it('a schema position: every field schema-documented, none example-only or undocumented; nested unrealizedPnL compared', () => {
    const report = observeDemoResponse('pnl', schemaPnl({ positions: [schemaPnlPosition()], orders: [schemaPnlOrder()], ordersForOpen: [schemaPnlOrderForOpen()] }), { salt: SALT });
    const positions = report.containers.positions!;
    expect(positions.documentedMissing).toEqual([]);
    expect(positions.exampleOnlyPresent).toEqual([]);
    expect(positions.undocumentedPresent).toEqual([]);
    expect(positions.fields?.unrealizedPnL).toMatchObject({ kinds: { object: 1 }, nested: { schemaMissing: [], undocumentedPresent: [] } });
    expect(report.containers.orders).toMatchObject({ documentedMissing: [], exampleOnlyPresent: [], undocumentedPresent: [] });
    expect(report.containers.ordersForOpen).toMatchObject({ documentedMissing: [], exampleOnlyPresent: [], undocumentedPresent: [] });
    expect(report.parser).toEqual({ outcome: 'accepted', positions: 1, orders: 1, ordersForOpen: 1 });
  });

  it('the REFERENCE_EXAMPLE shape is fully described, separated into schema / example-only / missing, and the parser refuses it afterwards', () => {
    const report = observeDemoResponse('pnl', schemaPnl({ positions: [referenceExamplePnlPosition()] }), { salt: SALT, showInstrumentIds: true });
    const positions = report.containers.positions!;
    expect(positions.count).toBe(1);
    expect(positions.exampleOnlyPresent).toEqual(['cid', 'closeConversionRate', 'closeRate', 'instrumentId', 'mirrorId', 'orderId', 'parentPositionId', 'pnL', 'positionId', 'redeemStatusId', 'settlementTypeId', 'timestamp']);
    expect(positions.undocumentedPresent).toEqual([]);
    expect(positions.documentedMissing).toEqual(['positionID', 'CID', 'instrumentID', 'mirrorID', 'parentPositionID', 'orderID', 'redeemStatusID', 'settlementTypeID', 'unrealizedPnL']);
    expect(positions.schemaDocumentedPresent).toContain('openRate');
    expect(positions.fields?.positionId).toEqual({ present: 1, kinds: { integer: 1 }, sign: { zero: 0, positive: 1, negative: 0 } });
    expect(positions.instrumentIds).toEqual([101]);
    expect(report.parser).toEqual({ outcome: 'refused', code: 'BROKER_RESPONSE_INVALID', detail: expect.stringContaining('clientPortfolio.positions[0].positionID') });
  });

  it('a field in neither schema nor example is undocumented; a nested key outside the schema is reported', () => {
    const report = observeDemoResponse('pnl', schemaPnl({ positions: [schemaPnlPosition({ brandNewField: true, unrealizedPnL: { pnL: 1, extraNested: 2 } })] }), { salt: SALT });
    expect(report.containers.positions?.undocumentedPresent).toEqual(['brandNewField']);
    expect(report.containers.positions?.fields?.unrealizedPnL?.nested?.undocumentedPresent).toEqual(['extraNested']);
    expect(report.containers.positions?.fields?.unrealizedPnL?.nested?.schemaMissing).toContain('closeRate');
  });

  it('a structurally broken pnl body is still described; the parser verdict is separate', () => {
    const report = observeDemoResponse('pnl', { clientPortfolio: { positions: 'not-an-array', credit: 'x' } }, { salt: SALT });
    expect(report.containers.positions).toMatchObject({ kind: 'string_other', count: 0 });
    expect(report.clientPortfolio.credit).toEqual({ kind: 'string_other' });
    expect(report.parser).toMatchObject({ outcome: 'refused', code: 'BROKER_RESPONSE_INVALID' });
  });

  it('pnl ids are pseudonymized in both spellings, never in clear', () => {
    const report = observeDemoResponse('pnl', schemaPnl({ positions: [referenceExamplePnlPosition()], orders: [schemaPnlOrder()] }), { salt: SALT, pseudonymizeIds: true });
    expect(Object.keys(report.containers.positions?.pseudonymousIds ?? {})).toEqual(['cid', 'mirrorId', 'orderId', 'parentPositionId', 'positionId']);
    expect(Object.keys(report.containers.orders?.pseudonymousIds ?? {})).toEqual(['cid', 'orderId']);
    expect(JSON.stringify(report)).not.toMatch(/9001|8001|5001|"123"/);
  });
});

describe('O21A.1 observation report: portfolio regression', () => {
  it('the portfolio report is unchanged in content for the documented fixture, and states its source', () => {
    const report = observeDemoPortfolio(documentedPortfolio(), { salt: SALT });
    expect(report).toEqual(observeDemoResponse('portfolio', documentedPortfolio(), { salt: SALT }));
    expect(report).toMatchObject({ source: 'portfolio', endpoint: 'GET /api/v1/trading/info/demo/portfolio', parser: { outcome: 'accepted', positions: 1, orders: 1 } });
    expect(report.containers.positions).toMatchObject({ documentedMissing: [], exampleOnlyPresent: [], undocumentedPresent: [] });
    expect(report.containers.ordersForOpen).toMatchObject({ documented: 'no_element_schema', count: 0 });
  });

  it('BUILD_LOCKS are unchanged', () => {
    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true });
  });
});
