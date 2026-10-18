// O21A observation harness: a sanitized schema report, never the response. It sends one GET of the demo portfolio and nothing
// else, refuses to run without explicit confirmation and the demo mode, prints no key, no value, and writes nothing to disk.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIRM_FLAG, SOURCE_OPERATIONS, runObservation } from '../../../src/broker/etoro/etoro-observe-cli.js';
import { DOCUMENTED_ORDER_FIELDS, DOCUMENTED_POSITION_FIELDS, kindOf, observeDemoPortfolio } from '../../../src/broker/etoro/etoro-observation.js';
import { HttpsEtoroTransport, type EtoroFetch } from '../../../src/broker/etoro/etoro-transport.js';
import { FixtureEtoroTransport, KEY_MARKER, USER_MARKER, emptyDemoPortfolio } from './o20-fixture.js';
import { documentedOrder, documentedPortfolio, documentedPosition } from './o21a-documented-fixture.js';

const SALT = Buffer.alloc(32, 7);
const ENV = { ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: KEY_MARKER, ETORO_USER_KEY: USER_MARKER };

describe('O21A observation: the report describes structure, never values', () => {
  it('the documented fixture: keys, counts, kinds; every documented field is present and none is undocumented', () => {
    const report = observeDemoPortfolio(documentedPortfolio(), { salt: SALT });
    expect(report.topLevelKeys).toEqual(['clientPortfolio']);
    expect(report.clientPortfolio.documentedMissing).toEqual([]);
    expect(report.clientPortfolio.undocumentedKeys).toEqual([]);
    expect(report.clientPortfolio.credit).toEqual({ kind: 'non_integer_number', sign: 'positive' });
    expect(report.containers.positions).toMatchObject({ kind: 'array', count: 1, documented: 'element_schema', documentedMissing: [], undocumentedPresent: [] });
    expect(report.containers.orders).toMatchObject({ kind: 'array', count: 1, documentedMissing: [], undocumentedPresent: [] });
    expect(report.containers.ordersForOpen).toMatchObject({ kind: 'array', count: 0, documented: 'no_element_schema' });
    expect(report.containers.positions?.fields?.positionID).toEqual({ present: 1, kinds: { integer: 1 }, sign: { zero: 0, positive: 1, negative: 0 } });
    expect(report.containers.positions?.fields?.openDateTime).toEqual({ present: 1, kinds: { string_iso8601_utc_z: 1 } });
    expect(report.containers.positions?.fields?.takeProfitRate?.sign).toEqual({ zero: 1, positive: 0, negative: 0 });
    expect(report.parser).toEqual({ outcome: 'accepted', positions: 1, orders: 1 });
  });

  it('no value from the response is in the report: no id, no amount, no rate, no timestamp, no customer id', () => {
    const text = JSON.stringify(observeDemoPortfolio(documentedPortfolio({ positions: [documentedPosition({ note: 'PRIVATE-TEXT-VALUE' })] }), { salt: SALT }));
    for (const value of ['2150896073', '7765437', '12402059', '5669649', '2020.7784', '280.35', '0.049485', '2024-08-01', 'PRIVATE-TEXT-VALUE', '1002', '100043']) {
      expect(text).not.toContain(value);
    }
  });

  it('ids are pseudonymized only on request, with the per-run salt; the same id gives the same pseudonym within a run', () => {
    const body = documentedPortfolio({ positions: [documentedPosition({ positionID: 1, orderID: 77 }), documentedPosition({ positionID: 2, orderID: 77 })], orders: [documentedOrder({ orderID: 77 })] });
    expect(observeDemoPortfolio(body, { salt: SALT }).containers.positions?.pseudonymousIds).toBeUndefined();
    const report = observeDemoPortfolio(body, { pseudonymizeIds: true, salt: SALT });
    const positionOrderIds = report.containers.positions?.pseudonymousIds?.orderID ?? [];
    expect(positionOrderIds).toHaveLength(2);
    expect(positionOrderIds[0]).toBe(positionOrderIds[1]);
    expect(report.containers.orders?.pseudonymousIds?.orderID).toEqual([positionOrderIds[0]]);
    expect(JSON.stringify(report)).not.toMatch(/"77"|:77\b/);
    // Another salt (another run) gives other pseudonyms: they cannot be linked across runs.
    const other = observeDemoPortfolio(body, { pseudonymizeIds: true, salt: Buffer.alloc(32, 9) });
    expect(other.containers.orders?.pseudonymousIds?.orderID).not.toEqual(report.containers.orders?.pseudonymousIds?.orderID);
  });

  it('eToro instrument ids are listed in clear only on explicit request', () => {
    expect(observeDemoPortfolio(documentedPortfolio(), { salt: SALT }).containers.positions?.instrumentIds).toBeUndefined();
    expect(observeDemoPortfolio(documentedPortfolio(), { showInstrumentIds: true, salt: SALT }).containers.positions?.instrumentIds).toEqual([1002]);
  });

  it('undocumented and missing fields are reported by name; key names that look like data are counted, not printed', () => {
    const position = documentedPosition({ newField: 1, 'acct 12345@example': true });
    delete position.lotCount;
    const report = observeDemoPortfolio(documentedPortfolio({ positions: [position] }), { salt: SALT });
    expect(report.containers.positions?.undocumentedPresent).toEqual(['newField']);
    expect(report.containers.positions?.documentedMissing).toEqual(['lotCount']);
    expect(report.containers.positions?.unnamedKeys).toBe(1);
    expect(JSON.stringify(report)).not.toContain('12345');
  });

  it('entries of containers without a documented element schema are described, and the parser refusal is reported by path', () => {
    const report = observeDemoPortfolio(documentedPortfolio({ extra: { ordersForOpen: [{ orderID: 5, instrumentID: 9, units: 1 }] } }), { salt: SALT });
    expect(report.containers.ordersForOpen).toMatchObject({ count: 1, documented: 'no_element_schema', undocumentedPresent: ['instrumentID', 'orderID', 'units'] });
    expect(report.parser).toEqual({ outcome: 'refused', code: 'BROKER_RESPONSE_INVALID', detail: expect.stringContaining('clientPortfolio.ordersForOpen') });
  });

  it('a new array container in clientPortfolio is reported too', () => {
    const report = observeDemoPortfolio(emptyDemoPortfolio({ futureOrders: [{ a: 1 }] }), { salt: SALT });
    expect(report.clientPortfolio.undocumentedKeys).toEqual(['futureOrders']);
    expect(report.containers.futureOrders).toMatchObject({ count: 1, documented: 'no_element_schema' });
  });

  it('kinds distinguish what the parser needs to know', () => {
    expect(kindOf(2 ** 53 + 2)).toBe('unsafe_integer');
    expect(kindOf('2024-08-01T07:44:26.103')).toBe('string_iso8601_no_zone');
    expect(kindOf('2024-08-01T07:44:26+02:00')).toBe('string_iso8601_offset');
    expect(kindOf('12.5')).toBe('string_numeric');
    expect(kindOf(1.5)).toBe('non_integer_number');
  });

  it('the documented field lists are the reference lists', () => {
    expect(DOCUMENTED_POSITION_FIELDS).toHaveLength(35);
    expect(DOCUMENTED_ORDER_FIELDS).toHaveLength(14);
    expect(Object.keys(documentedPosition()).sort()).toEqual([...DOCUMENTED_POSITION_FIELDS].sort());
    expect(Object.keys(documentedOrder()).sort()).toEqual([...DOCUMENTED_ORDER_FIELDS].sort());
  });
});

describe('O21A observation tool: gated, one GET, no secrets, nothing on disk', () => {
  it('without --confirm-live-read nothing is sent', async () => {
    let built = 0;
    const outcome = await runObservation({ env: ENV, argv: [], transport: () => ((built++), new FixtureEtoroTransport()) });
    expect(outcome).toMatchObject({ exitCode: 2 });
    expect(built).toBe(0);
  });

  it('without ETORO_TRADING_MODE=demo, with real, or with malformed keys nothing is sent', async () => {
    let built = 0;
    const transport = () => ((built++), new FixtureEtoroTransport());
    for (const env of [{ ...ENV, ETORO_TRADING_MODE: undefined }, { ...ENV, ETORO_TRADING_MODE: 'real' }, { ...ENV, ETORO_API_KEY: 'has space' }, { ...ENV, ETORO_USER_KEY: undefined }]) {
      expect(await runObservation({ env, argv: ['--source=portfolio', CONFIRM_FLAG], transport })).toMatchObject({ exitCode: 2 });
    }
    expect(await runObservation({ env: ENV, argv: ['--source=portfolio', CONFIRM_FLAG, '--dump-raw'], transport })).toMatchObject({ exitCode: 2 });
    expect(built).toBe(0);
  });

  it('with confirmation: exactly one GET of the demo portfolio through the O20 transport, and the report has no key', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch: EtoroFetch = async (url, init) => {
      requests.push({ url, method: String(init.method), body: init.body });
      return new Response(JSON.stringify(documentedPortfolio()), { status: 200 });
    };
    const outcome = await runObservation({ env: ENV, argv: ['--source=portfolio', CONFIRM_FLAG, '--pseudonymize-ids'], transport: (credentials) => new HttpsEtoroTransport({ credentials, fetch }) });
    expect(outcome.exitCode).toBe(0);
    expect(requests).toEqual([{ url: 'https://public-api.etoro.com/api/v1/trading/info/demo/portfolio', method: 'GET', body: undefined }]);
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(KEY_MARKER);
    expect(text).not.toContain(USER_MARKER);
    expect(text).not.toMatch(/x-api-key|x-user-key|authorization/i);
  });

  it('a broker failure reports a fixed code or status only', async () => {
    const t = new FixtureEtoroTransport();
    t.response = { status: 401, body: null };
    expect(await runObservation({ env: ENV, argv: ['--source=portfolio', CONFIRM_FLAG], transport: () => t })).toEqual({ exitCode: 1, error: 'broker returned HTTP 401' });
    const fetch: EtoroFetch = async () => {
      throw new Error('connect ECONNREFUSED ' + KEY_MARKER);
    };
    const failed = await runObservation({ env: ENV, argv: ['--source=portfolio', CONFIRM_FLAG], transport: (credentials) => new HttpsEtoroTransport({ credentials, fetch }) });
    expect(failed).toEqual({ exitCode: 1, error: 'BROKER_NOT_CONNECTED' });
  });

  it('the tool source writes no file and has one call site, over the fixed source operations (O21A.1; O22 added instrument-metadata)', () => {
    const source = readFileSync('src/broker/etoro/etoro-observe-cli.ts', 'utf8') + readFileSync('src/broker/etoro/etoro-observation.ts', 'utf8');
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|mkdir/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect([...source.matchAll(/\.call\(/g)]).toHaveLength(1);
    expect(source).toContain('.call(SOURCE_OPERATIONS[source])');
    expect(SOURCE_OPERATIONS).toEqual({ portfolio: 'portfolio.demo', pnl: 'pnl.demo', 'instrument-metadata': 'instrument.metadata.100001' });
  });

  it('nothing in the runtime imports the observation tool', () => {
    for (const file of ['src/runtime/compose.ts', 'src/runtime/bootstrap.ts', 'src/runtime/app.ts', 'src/runtime/main.ts']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/etoro-observ/);
    }
  });
});
