// O22: the one fixed instrument metadata read (prepared, not executed against eToro). Strict parser of the documented v2 shape,
// a report of four public fields, exactly one GET to exactly one fixed URL, the same gating as the other observation sources, and
// no mapping or registration from it. No network: every answer is scripted. The response bodies below follow the official
// reference schema; they are TEST DATA, not an observed eToro answer.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIRM_FLAG, runObservation } from '../../../src/broker/etoro/etoro-observe-cli.js';
import { METADATA_ENDPOINT, instrumentMetadataReport, parseInstrumentMetadata } from '../../../src/broker/etoro/etoro-instrument-metadata.js';
import { HttpsEtoroTransport, type EtoroFetch } from '../../../src/broker/etoro/etoro-transport.js';
import { KEY_MARKER, USER_MARKER } from './o20-fixture.js';

const ENV = { ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: KEY_MARKER, ETORO_USER_KEY: USER_MARKER };
const URL_V2 = 'https://public-api.etoro.com/api/v2/market-data/instruments?instrumentsIds=100001';

/** A schema-shaped answer (TEST DATA). */
function answer(entry: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    results: [{ instrumentId: 100001, displayName: 'Test Display Name', type: 'Crypto', symbol: 'TESTSYM', exchangeId: 8, multiplier: null, lastTradingDateTime: null, expirationDateTime: null, image: { uri: 'https://example.invalid/x.svg', backgroundColor: null }, ...entry }],
    pagination: { hasNext: false, nextPageToken: null, pageSize: 100 },
    ...extra,
  };
}

function recordingFetch(response: { status: number; body?: unknown }) {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetch: EtoroFetch = async (url, init) => {
    requests.push({ url, method: String(init.method), headers: { ...(init.headers as Record<string, string>) }, body: init.body });
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), { status: response.status });
  };
  return { requests, transport: (credentials: { apiKey: string; userKey: string }) => new HttpsEtoroTransport({ credentials, fetch }) };
}

describe('O22 instrument metadata parser', () => {
  it('keeps exactly id, type, symbol and display name of the one requested instrument', () => {
    expect(parseInstrumentMetadata(answer())).toEqual({ instrumentId: 100001, type: 'Crypto', symbol: 'TESTSYM', displayName: 'Test Display Name' });
    const report = instrumentMetadataReport(answer());
    expect(report).toEqual({ schema: 'etoro-instrument-metadata-observation:v1', endpoint: METADATA_ENDPOINT, verdict: 'accepted', metadata: { instrumentId: 100001, type: 'Crypto', symbol: 'TESTSYM', displayName: 'Test Display Name' } });
    expect(JSON.stringify(report)).not.toContain('example.invalid');
  });

  const refused: Array<[string, unknown]> = [
    ['not an object', []],
    ['no results', { pagination: {} }],
    ['empty results (not found)', { results: [] }],
    ['two results', { results: [answer().results, answer().results].flat() }],
    ['another instrument', answer({ instrumentId: 100000 })],
    ['id as a string', answer({ instrumentId: '100001' })],
    ['an undocumented type', answer({ type: 'Cryptocurrency' })],
    ['a type in another case', answer({ type: 'crypto' })],
    ['a missing type', answer({ type: undefined })],
    ['a symbol with spaces', answer({ symbol: 'A B' })],
    ['a symbol too long', answer({ symbol: 'X'.repeat(33) })],
    ['an empty display name', answer({ displayName: ' ' })],
    ['a display name with a control character', answer({ displayName: 'a\u0000b' })],
  ];
  for (const [label, body] of refused) {
    it('refuses ' + label + ', naming a path, never a value', () => {
      const report = instrumentMetadataReport(body);
      expect(report.verdict).toBe('refused');
      if (report.verdict === 'refused') {
        expect(report.code).toBe('BROKER_RESPONSE_INVALID');
        expect(report.detail).not.toMatch(/Cryptocurrency|A B|XXXXX/);
      }
    });
  }
});

describe('O22 instrument metadata read: exactly one fixed GET, gated like every observation', () => {
  it('sends one GET to the fixed v2 URL, with the keys as headers only and no body, and reports the four fields', async () => {
    const r = recordingFetch({ status: 200, body: answer() });
    const outcome = await runObservation({ env: ENV, argv: ['--source=instrument-metadata', CONFIRM_FLAG], transport: r.transport });
    expect(outcome).toEqual({ exitCode: 0, report: instrumentMetadataReport(answer()) });
    expect(r.requests.map((q) => [q.method, q.url, q.body])).toEqual([['GET', URL_V2, undefined]]);
    expect(r.requests[0]!.headers['x-api-key']).toBe(KEY_MARKER);
    expect(JSON.stringify(outcome)).not.toContain(KEY_MARKER);
    expect(JSON.stringify(outcome)).not.toContain(USER_MARKER);
  });

  it('a refused answer is still exit code 0 with verdict refused: the exit code alone is not success', async () => {
    const r = recordingFetch({ status: 200, body: answer({ type: 'CFD-ish' }) });
    const outcome = await runObservation({ env: ENV, argv: ['--source=instrument-metadata', CONFIRM_FLAG], transport: r.transport });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.exitCode === 0 && 'verdict' in outcome.report ? outcome.report.verdict : null).toBe('refused');
  });

  for (const status of [401, 403, 404, 429, 500]) {
    it(`HTTP ${status} fails closed with the status only, after exactly one request`, async () => {
      const r = recordingFetch({ status, body: { secret: 'ERROR-BODY-VALUE' } });
      const outcome = await runObservation({ env: ENV, argv: ['--source=instrument-metadata', CONFIRM_FLAG], transport: r.transport });
      expect(outcome).toEqual({ exitCode: 1, error: 'broker returned HTTP ' + status });
      expect(r.requests).toHaveLength(1);
    });
  }

  it('is refused without confirmation, outside demo mode, or with malformed keys: nothing is sent', async () => {
    const r = recordingFetch({ status: 200, body: answer() });
    for (const run of [
      { env: ENV, argv: ['--source=instrument-metadata'] },
      { env: { ...ENV, ETORO_TRADING_MODE: 'real' }, argv: ['--source=instrument-metadata', CONFIRM_FLAG] },
      { env: { ...ENV, ETORO_API_KEY: 'not a key' }, argv: ['--source=instrument-metadata', CONFIRM_FLAG] },
      { env: ENV, argv: ['--source=instrument-metadata', '--source=pnl', CONFIRM_FLAG] },
      { env: ENV, argv: ['--source=instruments', CONFIRM_FLAG] },
    ]) {
      expect((await runObservation({ ...run, transport: r.transport })).exitCode).toBe(2);
    }
    expect(r.requests).toHaveLength(0);
  });

  it('only the observation tool and the allowlist name the operation; nothing maps or registers from it automatically', () => {
    const files = ['src/broker/etoro', 'src/broker/etoro/execution', 'src/runtime'].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)));
    const users = files.filter((f) => readFileSync(f, 'utf8').includes("'instrument.metadata.100001'")).map((f) => f.replace(/\\/g, '/'));
    expect(users.sort()).toEqual(['src/broker/etoro/etoro-observe-cli.ts', 'src/broker/etoro/etoro-readonly.ts']);
    const cli = readFileSync('src/broker/etoro/etoro-observe-cli.ts', 'utf8');
    expect(cli).not.toMatch(/addMapping|applyGovernedEtoroMapping|register/);
  });
});
