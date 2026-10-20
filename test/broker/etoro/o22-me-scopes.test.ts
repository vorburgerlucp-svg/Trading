// O22 B5: the identity read GET /api/v1/me through the observation tool, reported as scope names only.
// TEST DOUBLE: scripted HTTP answers shaped after the eToro reference (identity and scopes); every identifier, name and date below is
// a synthetic marker so the tests can prove that none of them reaches the report. No network.
import { describe, expect, it } from 'vitest';
import { CONFIRM_FLAG, runObservation } from '../../../src/broker/etoro/etoro-observe-cli.js';
import { DEMO_WRITE_SCOPES, ME_ENDPOINT, meScopeChecks, meScopesReport, parseMeScopes } from '../../../src/broker/etoro/etoro-me-scopes.js';
import { HttpsEtoroTransport, type EtoroFetch } from '../../../src/broker/etoro/etoro-transport.js';
import { KEY_MARKER, USER_MARKER } from './o20-fixture.js';

const ENV = { ETORO_TRADING_MODE: 'demo', ETORO_API_KEY: KEY_MARKER, ETORO_USER_KEY: USER_MARKER };
const ME_URL = 'https://public-api.etoro.com/api/v1/me';
const PERSONAL = ['GCID-MARKER-1', 'REALCID-MARKER-2', 'DEMOCID-MARKER-3', 'USERNAME-MARKER', 'FIRSTNAME-MARKER', 'LASTNAME-MARKER', '1970-01-01', 'AVATAR-MARKER'];

function me(scopes: unknown = ['etoro-public:demo:read', 'etoro-public:demo:write', 'etoro-public:market-data:read'], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gcid: 'GCID-MARKER-1',
    realCid: 'REALCID-MARKER-2',
    demoCid: 'DEMOCID-MARKER-3',
    username: 'USERNAME-MARKER',
    firstName: 'FIRSTNAME-MARKER',
    lastName: 'LASTNAME-MARKER',
    dateOfBirth: '1970-01-01',
    avatarUrl: 'https://example.invalid/AVATAR-MARKER',
    playerLevel: 1,
    authChannel: 'keys',
    scopes,
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

describe('O22 /me scopes: parser and report', () => {
  it('keeps only the scope names (sorted, unique) and the checks; no identifier or profile field reaches the report', () => {
    const report = meScopesReport(me(['etoro-public:market-data:read', 'etoro-public:demo:write', 'etoro-public:demo:read', 'etoro-public:demo:read']));
    expect(report).toEqual({
      schema: 'etoro-me-scopes-observation:v1',
      endpoint: ME_ENDPOINT,
      verdict: 'accepted',
      scopes: ['etoro-public:demo:read', 'etoro-public:demo:write', 'etoro-public:market-data:read'],
      checks: { demoWrite: true, demoRead: true, realWrite: false, realRead: false },
    });
    const text = JSON.stringify(report);
    for (const marker of PERSONAL) expect(text).not.toContain(marker);
    expect(text).not.toMatch(/gcid|cid|username|firstName|dateOfBirth|authChannel/i);
  });

  it('demo write is proved by etoro-public:demo:write or etoro-public:trade.demo:write, and by nothing else', () => {
    expect(DEMO_WRITE_SCOPES).toEqual(['etoro-public:demo:write', 'etoro-public:trade.demo:write']);
    expect(meScopeChecks(['etoro-public:trade.demo:write']).demoWrite).toBe(true);
    expect(meScopeChecks(['etoro-public:demo:read', 'etoro-public:market-data:read']).demoWrite).toBe(false);
    expect(meScopeChecks(['etoro-public:real:write']).demoWrite).toBe(false);
    expect(meScopeChecks(['etoro-public:demo:writes', 'etoro-public:demo:write:extra']).demoWrite).toBe(false);
  });

  it('a real-account scope is reported as such, so that a human can decide about the key', () => {
    expect(meScopeChecks(['etoro-public:real:read', 'etoro-public:real:write', 'etoro-public:demo:write'])).toEqual({ demoWrite: true, demoRead: true, realWrite: true, realRead: true });
  });

  it('an empty scope list is accepted and proves nothing', () => {
    expect(meScopesReport(me([]))).toMatchObject({ verdict: 'accepted', scopes: [], checks: { demoWrite: false, demoRead: false } });
  });

  const refused: Array<[string, unknown]> = [
    ['not an object', []],
    ['no scopes', me([], { scopes: undefined })],
    ['scopes as one string', me('etoro-public:demo:write')],
    ['a scope that is not a string', me(['etoro-public:demo:write', 7])],
    ['a scope with spaces', me(['etoro-public: demo:write DEMOCID-MARKER-3'])],
    ['a scope in upper case', me(['ETORO-PUBLIC:DEMO:WRITE'])],
    ['too many scopes', me(Array.from({ length: 65 }, (_, i) => 'etoro-public:x' + i))],
  ];
  for (const [label, body] of refused) {
    it('refuses ' + label + ', naming the check, never a value', () => {
      const report = meScopesReport(body);
      expect(report.verdict).toBe('refused');
      expect(JSON.stringify(report)).not.toMatch(/MARKER|DEMO:WRITE/);
    });
  }

  it('parseMeScopes throws on a refused body', () => {
    expect(() => parseMeScopes({ scopes: null })).toThrow();
  });
});

describe('O22 /me read: exactly one fixed GET, gated like every observation', () => {
  it('sends one GET to /api/v1/me with the keys as headers only and no body, and reports scope names only', async () => {
    const r = recordingFetch({ status: 200, body: me() });
    const outcome = await runObservation({ env: ENV, argv: ['--source=me', CONFIRM_FLAG], transport: r.transport });
    expect(outcome).toEqual({ exitCode: 0, report: meScopesReport(me()) });
    expect(r.requests.map((q) => [q.method, q.url, q.body])).toEqual([['GET', ME_URL, undefined]]);
    expect(r.requests[0]!.headers['x-user-key']).toBe(USER_MARKER);
    const text = JSON.stringify(outcome);
    for (const marker of [KEY_MARKER, USER_MARKER, ...PERSONAL]) expect(text).not.toContain(marker);
  });

  for (const status of [401, 403, 429, 500]) {
    it(`HTTP ${status} fails closed with the status only, after exactly one request (no retry)`, async () => {
      const r = recordingFetch({ status, body: { secret: 'ERROR-BODY-VALUE', demoCid: 'DEMOCID-MARKER-3' } });
      const outcome = await runObservation({ env: ENV, argv: ['--source=me', CONFIRM_FLAG], transport: r.transport });
      expect(outcome).toEqual({ exitCode: 1, error: 'broker returned HTTP ' + status });
      expect(r.requests).toHaveLength(1);
    });
  }

  it('is refused without confirmation, outside demo mode, or with malformed or missing keys: nothing is sent', async () => {
    const r = recordingFetch({ status: 200, body: me() });
    for (const run of [
      { env: ENV, argv: ['--source=me'] },
      { env: { ...ENV, ETORO_TRADING_MODE: 'real' }, argv: ['--source=me', CONFIRM_FLAG] },
      { env: { ...ENV, ETORO_API_KEY: '' }, argv: ['--source=me', CONFIRM_FLAG] },
      { env: { ...ENV, ETORO_USER_KEY: 'not a key' }, argv: ['--source=me', CONFIRM_FLAG] },
      { env: ENV, argv: ['--source=me', '--source=pnl', CONFIRM_FLAG] },
    ]) {
      const outcome = await runObservation({ ...run, transport: r.transport });
      expect(outcome.exitCode).toBe(2);
    }
    expect(r.requests).toHaveLength(0);
  });
});
