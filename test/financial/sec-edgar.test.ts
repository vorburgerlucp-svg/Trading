import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strongO1Eligible } from '../../src/financial/financial-gateway.js';
import { verifyFinancialEvidence } from '../../src/financial/financial-evidence.js';
import { SEC_CONNECTOR_ID, SEC_MIN_INTERVAL_MS, SEC_PROVIDER, SecEdgarFundamentalsConnector, secUrlsOf, secUserAgentOf } from '../../src/financial/sec-edgar-fundamentals.js';
import { ResilientCaller, type FetchLike } from '../../src/market-data/providers/resilience.js';
import { AAPL_ID } from './fixtures.js';
import { ALL_FILINGS, baseConcepts, CIK, clock, CLOCK_ISO, COMPANYFACTS_URL, companyFactsText, FILINGS, FUNDAMENTALS_REQUEST, json200, reversedConcepts, SUBMISSIONS_URL, secCaller, secGateway, secHttp, secInstruments, standardAnswers, submissionsText, TEST_USER_AGENT } from './sec-fixtures.js';

// docs/SEC_EDGAR_FUNDAMENTALS_V1.md §1–§5, §9, §21–§25. The connector through the real gateway, with scripted HTTP answers. No network call is made.

const BYTES_32_MIB = 32 * 1024 * 1024;

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED';
  }
}

const sourceOf = (file: string) => readFileSync(new URL('../../src/financial/' + file, import.meta.url), 'utf8');

describe('identity and URLs (§1, §4)', () => {
  it('builds exactly the two SEC URLs for the mapped CIK, in order, and nothing else', async () => {
    const { gateway, http } = await secGateway(standardAnswers());
    await gateway.fetch(FUNDAMENTALS_REQUEST());
    expect(http.calls.map((c) => c.url)).toEqual([SUBMISSIONS_URL, COMPANYFACTS_URL]);
    expect(secUrlsOf(CIK)).toEqual({ submissions: SUBMISSIONS_URL, companyFacts: COMPANYFACTS_URL });
    expect(SUBMISSIONS_URL.startsWith('https://data.sec.gov/')).toBe(true);
    expect(COMPANYFACTS_URL.startsWith('https://data.sec.gov/')).toBe(true);
  });

  it('sends no credential: no Authorization header and no key in the URL', async () => {
    const { gateway, http } = await secGateway(standardAnswers());
    await gateway.fetch(FUNDAMENTALS_REQUEST());
    for (const call of http.calls) {
      expect(Object.keys(call.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
      expect(call.url).not.toMatch(/key|token|secret/i);
    }
  });

  it('refuses a mapped symbol that is not ten digits, before any HTTP call', async () => {
    const { gateway, http } = await secGateway(standardAnswers(), { instruments: await secInstruments('320193') });
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('REQUEST_INVALID');
    expect(http.calls).toHaveLength(0);
  });

  it('refuses a request with no mapping, before any HTTP call', async () => {
    const { gateway, http } = await secGateway(standardAnswers(), { instruments: await secInstruments(null) });
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('INSTRUMENT_MAPPING_MISSING');
    expect(http.calls).toHaveLength(0);
  });
});

describe('User-Agent and fair access (§2)', () => {
  it('accepts an identifier that carries a contact', () => {
    expect(secUserAgentOf('NEXUS Luc test@example.test')).toBe('NEXUS Luc test@example.test');
  });

  it('refuses a value without a contact, a blank value, a control character, and a value above 200 characters', () => {
    expect(secUserAgentOf('NEXUS')).toBeUndefined();
    expect(secUserAgentOf('   ')).toBeUndefined();
    expect(secUserAgentOf(undefined)).toBeUndefined();
    expect(secUserAgentOf('NEXUS a@b.co\u0007')).toBeUndefined();
    expect(secUserAgentOf('NEXUS ' + 'x'.repeat(200) + ' a@b.co')).toBeUndefined();
  });

  it('without a valid User-Agent the connector is not_connected, and no HTTP call is made', async () => {
    for (const userAgent of [undefined, 'NEXUS']) {
      const { gateway, connector, http } = await secGateway(standardAnswers(), { userAgent });
      expect(connector.connection()).toBe('not_connected');
      expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('DATA_NOT_CONNECTED');
      expect(http.calls).toHaveLength(0);
    }
  });

  it('sends the declared User-Agent and standard Accept headers on every call', async () => {
    const { gateway, http } = await secGateway(standardAnswers());
    await gateway.fetch(FUNDAMENTALS_REQUEST());
    for (const call of http.calls) {
      expect(call.headers['User-Agent']).toBe(TEST_USER_AGENT);
      expect(call.headers['Accept']).toBe('application/json');
    }
  });

  it('refuses a caller that paces faster than 125 ms between requests', () => {
    expect(SEC_MIN_INTERVAL_MS).toBe(125);
    const build = (minIntervalMs: number) =>
      new SecEdgarFundamentalsConnector({ userAgent: TEST_USER_AGENT, fetch: secHttp([]).fetch, caller: new ResilientCaller(SEC_PROVIDER, { minIntervalMs }), clock });
    const codeOfSync = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'UNEXPECTED';
      }
    };
    expect(codeOfSync(() => build(124))).toBe('REGISTRATION_INVALID');
    expect(codeOfSync(() => build(0))).toBe('REGISTRATION_INVALID');
    expect(codeOfSync(() => build(125))).toBeNull();
  });

  it('the second request starts at least 125 ms after the first', async () => {
    let t = 0;
    const started: number[] = [];
    const deps = { now: () => t, sleep: async (ms: number) => void (t += ms), random: () => 0.5 };
    const caller = new ResilientCaller(SEC_PROVIDER, { timeoutMs: 1000, maxAttempts: 1, minIntervalMs: SEC_MIN_INTERVAL_MS }, deps);
    const fetch: FetchLike = async (url) => {
      started.push(t);
      return { status: 200, headers: { get: () => null }, text: async () => (url === SUBMISSIONS_URL ? submissionsText(ALL_FILINGS) : companyFactsText(baseConcepts())) };
    };
    const { gateway } = await secGateway([], { caller, fetch });
    await gateway.fetch(FUNDAMENTALS_REQUEST());
    expect(started).toHaveLength(2);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(125);
  });
});

describe('HTTP meanings (§5)', () => {
  it('403 is access_denied: never not_entitled, and never retried', async () => {
    const { gateway, http } = await secGateway([{ status: 403 }]);
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('access_denied');
    expect(http.calls).toHaveLength(1);
  });

  it('401 is auth_failed and 404 is not_found, each without a retry', async () => {
    const unauthorised = await secGateway([{ status: 401 }]);
    expect(await codeOf(unauthorised.gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('auth_failed');
    expect(unauthorised.http.calls).toHaveLength(1);
    const missing = await secGateway([{ status: 404 }]);
    expect(await codeOf(missing.gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('not_found');
    expect(missing.http.calls).toHaveLength(1);
  });

  it('429 is retried with Retry-After, then succeeds', async () => {
    const { gateway, http } = await secGateway([{ status: 429, headers: { 'retry-after': '1' } }, ...standardAnswers()]);
    const evidence = await gateway.fetch(FUNDAMENTALS_REQUEST());
    expect(evidence.data.revenue).toBe('391035000000');
    expect(http.calls).toHaveLength(3);
  });

  it('5xx is retried, and the retries are bounded by maxAttempts', async () => {
    const { gateway, http } = await secGateway([{ status: 503 }], { caller: secCaller({ maxAttempts: 3 }) });
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('provider_unavailable');
    expect(http.calls).toHaveLength(3);
  });

  it('malformed JSON is schema_invalid and is not retried', async () => {
    const { gateway, http } = await secGateway([json200('not json')]);
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('SCHEMA_INVALID');
    expect(http.calls).toHaveLength(1);
  });
});

describe('bounded responses and the host (§4)', () => {
  it('a Content-Length above 32 MiB is refused before the body is read', async () => {
    let bodyRead = false;
    const fetch: FetchLike = async () => ({
      status: 200,
      headers: { get: (name: string) => (name === 'content-length' ? String(BYTES_32_MIB + 1) : null) },
      text: async () => {
        bodyRead = true;
        return '';
      },
    });
    const { gateway } = await secGateway([], { fetch });
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('SCHEMA_INVALID');
    expect(bodyRead).toBe(false);
  });

  it('a body above 32 MiB is refused after the read', async () => {
    const { gateway } = await secGateway([json200('x'.repeat(BYTES_32_MIB + 1))]);
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('SCHEMA_INVALID');
  });

  it('a response whose final URL is not data.sec.gov is refused, and nothing is followed', async () => {
    const { gateway, http } = await secGateway([{ status: 200, url: 'https://evil.example/submissions.json', body: submissionsText(ALL_FILINGS) }]);
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('CONNECTOR_PAYLOAD_INVALID');
    expect(http.calls).toHaveLength(1);
  });

  it('a malformed Content-Length is refused', async () => {
    const fetch: FetchLike = async () => ({ status: 200, headers: { get: (name: string) => (name === 'content-length' ? '12x' : null) }, text: async () => '' });
    const { gateway } = await secGateway([], { fetch });
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('SCHEMA_INVALID');
  });
});

describe('period and capability guards (§9, §24)', () => {
  it('Q4 is refused before any HTTP call', async () => {
    const { gateway, http } = await secGateway(standardAnswers());
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST('2024-Q4')))).toBe('REQUEST_INVALID');
    expect(http.calls).toHaveLength(0);
  });

  it('a news request is refused: the registry does not allow it for this connector', async () => {
    const { gateway, http } = await secGateway(standardAnswers());
    const news = { requestId: 'r-news', capability: 'news', connectorId: SEC_CONNECTOR_ID, asOf: '2026-06-01T10:00:00.000Z', environment: 'research', instrumentId: AAPL_ID };
    expect(await codeOf(gateway.fetch(news))).toBe('CAPABILITY_NOT_ALLOWED');
    expect(http.calls).toHaveLength(0);
  });

  it('exposes only fundamentals, and has no batch path', async () => {
    const { gateway, connector, http } = await secGateway(standardAnswers());
    expect(connector.capabilities()).toEqual(['fundamentals']);
    expect((connector as { fetchBatch?: unknown }).fetchBatch).toBeUndefined();
    expect(await codeOf(gateway.fetchBatch(FUNDAMENTALS_REQUEST()))).toBe('CAPABILITY_NOT_IMPLEMENTED');
    expect(http.calls).toHaveLength(0);
  });

  it('a source with no implicit FX: a EUR request for a company without EUR facts is absent', async () => {
    const { gateway } = await secGateway(standardAnswers());
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST('2024-FY', undefined, 'EUR')))).toBe('PROVIDER_DATA_ABSENT');
  });
});

describe('evidence through the gateway (§21–§25)', () => {
  it('returns verified FinancialEvidence for the FY2024 fixture, with provider time and effective time null', async () => {
    const { gateway } = await secGateway(standardAnswers());
    const evidence = await gateway.fetch(FUNDAMENTALS_REQUEST());
    expect(evidence).toMatchObject({
      provider: SEC_PROVIDER,
      transport: 'rest',
      connectorId: SEC_CONNECTOR_ID,
      capability: 'fundamentals',
      providerPublishedAt: null,
      effectiveAt: null,
      retrievedAt: CLOCK_ISO,
      o1Status: 'EXTERNAL_FINANCIAL_EVIDENCE_UNSEALED',
      license: { status: 'research_only', redistribution: 'internal_only' },
    });
    expect(evidence.data).toMatchObject({ period: '2024-FY', currency: 'USD', revenue: '391035000000', eps: '6.08', ebit: null, debt: null, capex: null, freeCashFlow: null });
    expect(evidence.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verifyFinancialEvidence(evidence)).not.toThrow();
    expect(strongO1Eligible(evidence).eligible).toBe(false);
  });

  it('the User-Agent never appears in the evidence', async () => {
    const { gateway } = await secGateway(standardAnswers());
    expect(JSON.stringify(await gateway.fetch(FUNDAMENTALS_REQUEST()))).not.toContain(TEST_USER_AGENT);
  });

  it('the raw hash does not depend on the User-Agent: the same response gives the same identity under another contact', async () => {
    const a = await (await secGateway(standardAnswers(), { userAgent: 'NEXUS one one@example.test' })).gateway.fetch(FUNDAMENTALS_REQUEST());
    const b = await (await secGateway(standardAnswers(), { userAgent: 'NEXUS two two@example.test' })).gateway.fetch(FUNDAMENTALS_REQUEST());
    expect(b.rawPayloadHash).toBe(a.rawPayloadHash);
    expect(b.evidenceId).toBe(a.evidenceId);
  });

  it('the same response fetched twice gives the same identity', async () => {
    const a = await (await secGateway(standardAnswers())).gateway.fetch(FUNDAMENTALS_REQUEST());
    const b = await (await secGateway(standardAnswers())).gateway.fetch(FUNDAMENTALS_REQUEST());
    expect(b).toEqual({ ...a, nexusReceivedAt: b.nexusReceivedAt, createdAt: b.createdAt });
  });

  it('a reordered companyfacts response gives the same data and evidence identity; the raw hash differs because the bytes differ', async () => {
    const original = await (await secGateway(standardAnswers())).gateway.fetch(FUNDAMENTALS_REQUEST());
    const shuffled = await (await secGateway(standardAnswers(ALL_FILINGS, reversedConcepts(baseConcepts())))).gateway.fetch(FUNDAMENTALS_REQUEST());
    expect(shuffled.data).toEqual(original.data);
    expect(shuffled.evidenceId).toBe(original.evidenceId);
    expect(shuffled.rawPayloadHash).not.toBe(original.rawPayloadHash);
  });

  it('a changed selected fact changes the evidence identity and the raw hash', async () => {
    const concepts = baseConcepts();
    concepts.GrossProfit = { USD: [{ start: '2023-10-01', end: '2024-09-28', val: '180683000001', accn: FILINGS.fy2024.accession, fy: 2024, fp: 'FY', form: '10-K', filed: FILINGS.fy2024.filingDate }] };
    const original = await (await secGateway(standardAnswers())).gateway.fetch(FUNDAMENTALS_REQUEST());
    const changed = await (await secGateway(standardAnswers(ALL_FILINGS, concepts))).gateway.fetch(FUNDAMENTALS_REQUEST());
    expect(changed.data.grossProfit).toBe('180683000001');
    expect(changed.evidenceId).not.toBe(original.evidenceId);
    expect(changed.rawPayloadHash).not.toBe(original.rawPayloadHash);
  });

  it('a filing with no balance sheet value is PROVIDER_DATA_ABSENT through the gateway, never an empty record', async () => {
    const concepts = { RevenueFromContractWithCustomerExcludingAssessedTax: baseConcepts().RevenueFromContractWithCustomerExcludingAssessedTax! };
    const { gateway } = await secGateway([json200(submissionsText(ALL_FILINGS)), json200(companyFactsText(concepts))]);
    expect(await codeOf(gateway.fetch(FUNDAMENTALS_REQUEST()))).toBe('PROVIDER_DATA_ABSENT');
  });
});

describe('static guarantees (§3, §4)', () => {
  it('the SEC module contains no Authorization header, no credential reference and no secret lookup', () => {
    const text = sourceOf('sec-edgar-fundamentals.ts');
    expect(text).not.toMatch(/['"]Authorization['"]|apikey|api_key|credentialRef|secrets\.get/i);
  });

  it('the connector identity is the one the design names', () => {
    expect(SEC_CONNECTOR_ID).toBe('sec-edgar-fundamentals-rest');
    expect(SEC_PROVIDER).toBe('sec-edgar');
    expect(secCaller().policy.minIntervalMs).toBe(125);
  });
});
