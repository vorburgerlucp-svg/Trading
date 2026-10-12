import { describe, expect, it } from 'vitest';
import { MassiveNewsRestConnector } from '../../src/financial/massive-news-connector.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { EnvironmentSecretProvider } from '../../src/financial/secrets.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { ResilientCaller } from '../../src/market-data/providers/resilience.js';
import { AAPL_ID, change, UNREVIEWED } from './fixtures.js';
import { ARTICLE_A, ARTICLE_B, ARTICLE_INJECTION, MASSIVE_CONNECTOR, MASSIVE_PROVIDER, MASSIVE_SECRET, NEWS_REQUEST, PAGE, json, massiveInstruments, scriptedFetch, type Answer } from './massive-fixtures.js';

// docs/MASSIVE_NEWS_CONNECTOR_V1.md. The Massive REST adapter is deterministic and read-only: one endpoint, one bounded page, a strict schema, one
// evidence record per article, and every provider-derived string treated as untrusted text. Every HTTP answer here is injected.

const clock = () => new Date('2026-06-01T10:00:00.000Z');
const sleeps: number[] = [];
const deps = { now: () => 0, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5 };
const POLICY = { timeoutMs: 1000, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, rateLimitFallbackMs: 1 };

async function setup(answers: Answer[], options: { secret?: string | undefined; limit?: number; instruments?: Awaited<ReturnType<typeof massiveInstruments>>; enabled?: boolean } = {}) {
  const http = scriptedFetch(answers);
  const secret = 'secret' in options ? options.secret : MASSIVE_SECRET;
  const connector = new MassiveNewsRestConnector({
    secrets: { get: (ref: string) => (ref === 'massive-api-key' ? secret : undefined) },
    fetch: http.fetch,
    caller: new ResilientCaller(MASSIVE_PROVIDER, POLICY, deps),
    clock,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: MASSIVE_CONNECTOR, provider: MASSIVE_PROVIDER, transport: 'rest', capabilities: ['news'], license: UNREVIEWED, mode: 'RESEARCH' }, change());
  if (options.enabled !== false) await registry.enable(MASSIVE_CONNECTOR, change());
  const gateway = new FinancialDataGateway({ registry, instruments: options.instruments ?? (await massiveInstruments()), connectors: [connector], clock });
  return { gateway, connector, http, registry };
}

const batch = (gateway: FinancialDataGateway, request = NEWS_REQUEST()) => gateway.fetchBatch(request);

describe('authentication and secrets (§2)', () => {
  it('sends the key as a Bearer header, and the URL carries no secret', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A]))]);
    await batch(gateway);
    expect(http.calls[0]!.headers.Authorization).toBe('Bearer ' + MASSIVE_SECRET);
    expect(http.calls[0]!.url).not.toContain(MASSIVE_SECRET);
    expect(http.calls[0]!.url).not.toMatch(/apiKey|api_key|token=/i);
  });

  it('no key configured: the connector is not_connected and the gateway refuses with DATA_NOT_CONNECTED and no call', async () => {
    const { gateway, connector, http } = await setup([json(200, PAGE([ARTICLE_A]))], { secret: undefined });
    expect(connector.connection()).toBe('not_connected');
    await expect(batch(gateway)).rejects.toMatchObject({ code: 'DATA_NOT_CONNECTED' });
    expect(http.calls).toHaveLength(0);
  });

  it('the key never appears in evidence or in an error message', async () => {
    const ok = await setup([json(200, PAGE([ARTICLE_A]))]);
    const result = await batch(ok.gateway);
    expect(JSON.stringify(result)).not.toContain(MASSIVE_SECRET);
    const denied = await setup([{ status: 401, body: 'denied for key ' + MASSIVE_SECRET }]);
    const err = await batch(denied.gateway).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(MASSIVE_SECRET);
    expect(JSON.stringify(err)).not.toContain(MASSIVE_SECRET);
  });

  it('the environment provider reads only the mapped variable MASSIVE_API_KEY, and an empty value is no key', () => {
    const env = new EnvironmentSecretProvider({ MASSIVE_API_KEY: 'x-value', OTHER: 'nope' });
    expect(env.get('massive-api-key')).toBe('x-value');
    expect(env.get('other')).toBeUndefined();
    expect(new EnvironmentSecretProvider({ MASSIVE_API_KEY: '' }).get('massive-api-key')).toBeUndefined();
  });
});

describe('endpoint and instrument identity (§1, §4)', () => {
  it('requests exactly the official endpoint with the bounded deterministic parameters', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A]))]);
    await batch(gateway);
    const url = new URL(http.calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.massive.com/v2/reference/news');
    expect(Object.fromEntries(url.searchParams)).toEqual({ ticker: 'AAPL', limit: '10', order: 'desc', sort: 'published_utc' });
  });

  it('the ticker comes from the InstrumentRegistry mapping, not from the request', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A]))], { instruments: await massiveInstruments('AAPL.US') });
    await batch(gateway);
    expect(new URL(http.calls[0]!.url).searchParams.get('ticker')).toBe('AAPL.US');
  });

  it('a missing mapping is refused before any call', async () => {
    const instruments = await massiveInstruments();
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A]))], { instruments: instruments });
    await expect(batch(gateway, NEWS_REQUEST('r-x', '1970-01-01T00:00:00.000Z'))).rejects.toMatchObject({ code: 'INSTRUMENT_MAPPING_MISSING' });
    expect(http.calls).toHaveLength(0);
  });

  it('a wrong ticker in the returned article cannot remap the NEXUS identity', async () => {
    const wrong = { ...ARTICLE_A, tickers: ['MSFT'] };
    const { gateway, http } = await setup([json(200, PAGE([wrong]))]);
    const [evidence] = (await batch(gateway)).evidence;
    expect(evidence!.instrumentId).toBe(AAPL_ID);
    expect(new URL(http.calls[0]!.url).searchParams.get('ticker')).toBe('AAPL');
  });

  it('the caller cannot add query fields: an unknown request field is refused before any call', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A]))]);
    await expect(batch(gateway, { ...NEWS_REQUEST(), query: { apiKey: 'steal' } } as never)).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(http.calls).toHaveLength(0);
  });
});

describe('strict response schema (§5): each malformed page fails closed', () => {
  const cases: Array<[string, unknown, number?]> = [
    ['an unexpected root field', { ...PAGE([ARTICLE_A]), debug: true }],
    ['a status other than OK', { ...PAGE([ARTICLE_A]), status: 'ERROR' }],
    ['results that is not an array', { status: 'OK', results: { id: 'x' } }],
    ['more results than the configured limit', PAGE([ARTICLE_A, ARTICLE_B, ARTICLE_INJECTION]), 2],
    ['an article without an id', PAGE([{ ...ARTICLE_A, id: undefined }])],
    ['an article without a publisher name', PAGE([{ ...ARTICLE_A, publisher: { homepage_url: 'https://wire.example.invalid' } }])],
    ['a publisher with an unexpected field', PAGE([{ ...ARTICLE_A, publisher: { name: 'Example Wire', bogus: 1 } }])],
    ['a published time without a zone', PAGE([{ ...ARTICLE_A, published_utc: '2026-01-01 12:00:00' }])],
    ['a published time with an offset instead of UTC', PAGE([{ ...ARTICLE_A, published_utc: '2026-01-01T12:00:00+02:00' }])],
    ['an article URL over plain HTTP', PAGE([{ ...ARTICLE_A, article_url: 'http://news.example.invalid/art-001' }])],
    ['an article with an unexpected field', PAGE([{ ...ARTICLE_A, sentiment_score: 0.9 }])],
    ['two articles with the same id', PAGE([ARTICLE_A, { ...ARTICLE_B, id: ARTICLE_A.id }])],
    ['an empty title', PAGE([{ ...ARTICLE_A, title: '' }])],
  ];
  for (const [label, page, limit] of cases) {
    it('refuses ' + label, async () => {
      const { gateway, http } = await setup([json(200, page)], limit !== undefined ? { limit } : {});
      await expect(batch(gateway)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
      expect(http.calls).toHaveLength(1);
    });
  }
});

describe('news normalization and untrusted text (§7, §8, §9)', () => {
  it('a valid article becomes canonical news evidence v2 from the massive provider', async () => {
    const { gateway } = await setup([json(200, PAGE([ARTICLE_A]))]);
    const [e] = (await batch(gateway)).evidence;
    expect(e).toMatchObject({ schemaVersion: 'financial-evidence:v2', connectorId: MASSIVE_CONNECTOR, provider: MASSIVE_PROVIDER, transport: 'rest', capability: 'news', instrumentId: AAPL_ID });
    expect(e!.data).toEqual({ articleId: 'art-001', publisher: 'Example Wire', publishedAt: '2026-01-01T12:00:00.000Z', url: 'https://news.example.invalid/art-001' });
    expect(e!.providerPublishedAt).toBe('2026-01-01T12:00:00.000Z');
  });

  it('title and description are separate untrusted text blocks with distinct sources', async () => {
    const { gateway } = await setup([json(200, PAGE([ARTICLE_A]))]);
    const [e] = (await batch(gateway)).evidence;
    expect(e!.textBlocks!.map((b) => b.source)).toEqual(['massive:title', 'massive:description']);
    expect(e!.textBlocks!.map((b) => b.text)).toEqual(['Apple reports quarterly results', 'Revenue grew.']);
  });

  it('an article without a description has only the title block', async () => {
    const { gateway } = await setup([json(200, PAGE([ARTICLE_B]))]);
    const [e] = (await batch(gateway)).evidence;
    expect(e!.textBlocks!.map((b) => b.source)).toEqual(['massive:title']);
  });

  it('an injected instruction in a title is quarantined, with no second call and no workflow effect', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_INJECTION]))]);
    const [e] = (await batch(gateway)).evidence;
    const [title] = e!.textBlocks!;
    expect(title).toMatchObject({ source: 'massive:title', quarantined: true, text: expect.stringContaining('QUARANTINED') });
    expect(title!.flags.map((f) => f.rule)).toContain('override_instructions');
    expect(http.calls).toHaveLength(1);
  });

  it('several articles produce independent evidence records, each with its own identity and raw hash', async () => {
    const { gateway } = await setup([json(200, PAGE([ARTICLE_A, ARTICLE_B, ARTICLE_INJECTION]))]);
    const result = await batch(gateway);
    expect(result.evidence).toHaveLength(3);
    expect(new Set(result.evidence.map((e) => e.evidenceId)).size).toBe(3);
    expect(new Set(result.evidence.map((e) => e.rawPayloadHash)).size).toBe(3);
    const times = result.evidence.map((e) => e.providerPublishedAt!);
    expect(times).toEqual([...times].sort());
  });

  it('the raw payload hash is the canonical hash of that article as the page delivered it', async () => {
    const { gateway } = await setup([json(200, PAGE([ARTICLE_A]))]);
    const [e] = (await batch(gateway)).evidence;
    expect(e!.rawPayloadHash).toBe(hashOf(JSON.parse(JSON.stringify(ARTICLE_A))));
  });

  it('provider sentiment and insights never reach the evidence', async () => {
    const { gateway } = await setup([json(200, PAGE([ARTICLE_A]))]);
    const [e] = (await batch(gateway)).evidence;
    const text = JSON.stringify(e);
    expect(text).not.toContain('positive');
    expect(text).not.toContain('insights');
    expect(text).not.toContain('sentiment');
  });
});

describe('pagination: one bounded page, next_url never followed (§6)', () => {
  it('no next_url: the page is complete', async () => {
    const { gateway } = await setup([json(200, PAGE([ARTICLE_A]))]);
    expect((await batch(gateway)).complete).toBe(true);
  });

  it('a next_url on the Massive host is reported, not followed: the batch is incomplete and there is one call', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A], { next_url: 'https://api.massive.com/v2/reference/news?cursor=abc' }))]);
    expect((await batch(gateway)).complete).toBe(false);
    expect(http.calls).toHaveLength(1);
  });

  it('a next_url on another host is refused as schema invalid, and never followed', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A], { next_url: 'https://attacker.example.invalid/steal' }))]);
    await expect(batch(gateway)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(http.calls).toHaveLength(1);
  });

  it('a next_url carrying a credential is refused as schema invalid', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A], { next_url: 'https://api.massive.com/v2/reference/news?apiKey=abc' }))]);
    await expect(batch(gateway)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(http.calls).toHaveLength(1);
  });
});

describe('HTTP errors and retries (§12)', () => {
  it('401 is an authentication failure, not retried', async () => {
    const { gateway, http } = await setup([json(401, { error: 'bad key' })]);
    await expect(batch(gateway)).rejects.toMatchObject({ code: 'auth_failed' });
    expect(http.calls).toHaveLength(1);
  });

  it('403 is an entitlement failure, distinct from authentication, not retried', async () => {
    const { gateway, http } = await setup([json(403, { error: 'not entitled' })]);
    await expect(batch(gateway)).rejects.toMatchObject({ code: 'not_entitled', retryable: false });
    expect(http.calls).toHaveLength(1);
  });

  it('429 is retried after the Retry-After delay, and then succeeds', async () => {
    const { gateway, http } = await setup([json(429, {}, { 'retry-after': '2' }), json(200, PAGE([ARTICLE_A]))]);
    expect((await batch(gateway)).evidence).toHaveLength(1);
    expect(http.calls).toHaveLength(2);
    expect(sleeps).toContain(2000);
  });

  it('a 5xx is retried a bounded number of times, then reported as provider unavailable', async () => {
    const { gateway, http } = await setup([json(503, {})]);
    await expect(batch(gateway)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(http.calls).toHaveLength(3);
  });

  it('malformed JSON is schema invalid and is not retried', async () => {
    const { gateway, http } = await setup([{ status: 200, body: '<html>not json</html>' }]);
    await expect(batch(gateway)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(http.calls).toHaveLength(1);
  });
});

describe('duplicates and changed articles (§9)', () => {
  it('the same article under the same request has the same evidence id', async () => {
    const a = (await batch((await setup([json(200, PAGE([ARTICLE_A]))])).gateway)).evidence[0]!;
    const b = (await batch((await setup([json(200, PAGE([ARTICLE_A]))])).gateway, NEWS_REQUEST('r-later'))).evidence[0]!;
    expect(b.evidenceId).toBe(a.evidenceId);
  });

  it('a changed title is a new content hash and a new evidence id', async () => {
    const a = (await batch((await setup([json(200, PAGE([ARTICLE_A]))])).gateway)).evidence[0]!;
    const b = (await batch((await setup([json(200, PAGE([{ ...ARTICLE_A, title: 'Apple revises guidance' }]))])).gateway)).evidence[0]!;
    expect(b.contentHash).not.toBe(a.contentHash);
    expect(b.evidenceId).not.toBe(a.evidenceId);
  });

  it('a changed published time is a new provider publication time and a new evidence id', async () => {
    const a = (await batch((await setup([json(200, PAGE([ARTICLE_A]))])).gateway)).evidence[0]!;
    const b = (await batch((await setup([json(200, PAGE([{ ...ARTICLE_A, published_utc: '2026-01-05T12:00:00Z' }]))])).gateway)).evidence[0]!;
    expect(b.providerPublishedAt).not.toBe(a.providerPublishedAt);
    expect(b.evidenceId).not.toBe(a.evidenceId);
  });
});

describe('gateway governance applies to the batch path, and the single path is closed (§7)', () => {
  it('a disabled connector is refused before any call', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A]))], { enabled: false });
    await expect(batch(gateway)).rejects.toMatchObject({ code: 'CONNECTOR_DISABLED' });
    expect(http.calls).toHaveLength(0);
  });

  it('a production request on an unreviewed source is refused before any call', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A]))]);
    await expect(batch(gateway, { ...NEWS_REQUEST(), environment: 'production' })).rejects.toMatchObject({ code: 'LICENSE_NOT_ALLOWED' });
    expect(http.calls).toHaveLength(0);
  });

  it('the single-response path refuses a multi-article provider: no article is silently chosen', async () => {
    const { gateway, http } = await setup([json(200, PAGE([ARTICLE_A, ARTICLE_B]))]);
    await expect(gateway.fetch(NEWS_REQUEST())).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(http.calls).toHaveLength(0);
  });
});
