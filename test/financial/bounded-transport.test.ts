import { describe, expect, it } from 'vitest';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { FinancialGatewayError } from '../../src/financial/financial-types.js';
import { MASSIVE_MAX_RESPONSE_BYTES, MassiveNewsRestConnector } from '../../src/financial/massive-news-connector.js';
import { RestFinancialConnector } from '../../src/financial/rest-transport.js';
import { secTextOf, type SecTextRequest } from '../../src/financial/sec-transport.js';
import { ResilientCaller, type FetchLike } from '../../src/market-data/providers/resilience.js';
import { bodyOf, chunksOf, neverEndingBody, newProbe, responseWith, textResponse } from './http-body-fixtures.js';
import { AAPL_ID, change, FUNDAMENTALS_RAW, instrumentRegistry, PROVIDER, RESEARCH_ONLY, T0 } from './fixtures.js';
import { clock, FUNDAMENTALS_REQUEST, secCaller, secGateway } from './sec-fixtures.js';
import { ARTICLE_A, MASSIVE_PROVIDER, MASSIVE_SECRET, NEWS_REQUEST, PAGE, massiveInstruments } from './massive-fixtures.js';

// docs/BOUNDED_STREAMING_HTTP_TRANSPORT_V1.md §9–§19. The three migrated financial success paths (SEC, Massive, generic REST) read their bodies through the
// bounded reader. Status is judged before any body is read. A body that never completes is controlled by the caller's timeout. No network: every answer is
// scripted.

const TEXT = 'x'.repeat(8);

function secRequest(overrides: Partial<SecTextRequest> = {}): SecTextRequest {
  return {
    fetch: async () => textResponse(TEXT),
    clock,
    provider: 'sec-edgar',
    accept: 'application/json',
    userAgent: 'NEXUS fixture test@example.test',
    url: 'https://data.sec.gov/submissions/CIK0000320193.json',
    signal: new AbortController().signal,
    allowedHosts: ['data.sec.gov'],
    maxBytes: 64,
    refuse: (kind, message) => {
      throw Object.assign(new Error(message), { kind });
    },
    ...overrides,
  };
}

async function refusalOf(promise: Promise<unknown>): Promise<{ kind?: string } | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as { kind?: string };
  }
}

describe('the SEC transport reads through the bounded reader (§17)', () => {
  it('returns the exact text from a streamed body, with the same result for any chunking', async () => {
    const whole = await secTextOf(secRequest({ fetch: async () => textResponse(TEXT) }));
    const chunked = await secTextOf(secRequest({ fetch: async () => responseWith({ body: bodyOf(chunksOf(TEXT, 3)) }) }));
    expect(whole).toBe(TEXT);
    expect(chunked).toBe(whole);
  });

  it('a success response with no body is refused as a body problem, and nothing is read', async () => {
    const refusal = await refusalOf(secTextOf(secRequest({ fetch: async () => responseWith({ body: undefined }) })));
    expect(refusal?.kind).toBe('body');
  });

  it('a stream larger than the bound, with no Content-Length, is refused as a body problem', async () => {
    const refusal = await refusalOf(secTextOf(secRequest({ maxBytes: 4, fetch: async () => responseWith({ body: bodyOf(chunksOf('0123456789', 2)) }) })));
    expect(refusal?.kind).toBe('body');
  });

  it('a declared length above the bound is refused before any body read', async () => {
    const probe = newProbe();
    const refusal = await refusalOf(secTextOf(secRequest({ maxBytes: 4, fetch: async () => responseWith({ headers: { 'content-length': '9' }, body: bodyOf(TEXT, probe) }) })));
    expect(refusal?.kind).toBe('body');
    expect(probe.reads).toBe(0);
  });

  it('a foreign final URL is refused before the body is read, and nothing is followed', async () => {
    const probe = newProbe();
    const refusal = await refusalOf(secTextOf(secRequest({ fetch: async () => responseWith({ url: 'https://evil.example/x.json', body: bodyOf(TEXT, probe) }) })));
    expect(refusal?.kind).toBe('host');
    expect(probe.reads).toBe(0);
  });

  it('a 500 status is a provider error, and its body is never read', async () => {
    const probe = newProbe();
    const error = await secTextOf(secRequest({ fetch: async () => responseWith({ status: 500, body: bodyOf(TEXT, probe) }) })).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('provider_unavailable');
    expect(probe.reads).toBe(0);
  });
});

describe('the caller timeout covers a body that never completes (§10, brief 10)', () => {
  it('a SEC body that never completes is ended by the existing timeout, and the call fails as timeout', async () => {
    const { gateway } = await secGateway([], {
      caller: secCaller({ timeoutMs: 30, maxAttempts: 1 }),
      fetch: async () => responseWith({ body: neverEndingBody() }),
    });
    expect(await gateway.fetch(FUNDAMENTALS_REQUEST()).catch((e: { code?: string }) => e.code)).toBe('timeout');
  });
});

describe('the Massive success body is bounded (§15–§16)', () => {
  it('the Massive bound is 4 MiB', () => {
    expect(MASSIVE_MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
  });

  it('a Massive body larger than its configured bound is SCHEMA_INVALID', async () => {
    const connector = await massiveConnector(async () => responseWith({ body: bodyOf(JSON.stringify(PAGE([ARTICLE_A]))) }), { maxResponseBytes: 16 });
    expect(await connector.fetchBatch(NEWS_REQUEST() as never, await massiveMapping()).catch((e: { code?: string }) => e.code)).toBe('SCHEMA_INVALID');
  });

  it('the default Massive bound refuses valid JSON one byte over 4 MiB, with no explicit option', async () => {
    const json = JSON.stringify(PAGE([ARTICLE_A]));
    const padding = MASSIVE_MAX_RESPONSE_BYTES + 1 - new TextEncoder().encode(json).byteLength;
    const connector = await massiveConnector(async () => responseWith({ body: bodyOf(json + ' '.repeat(padding)) }));
    expect(await connector.fetchBatch(NEWS_REQUEST() as never, await massiveMapping()).then(() => 'accepted', (e: { code?: string }) => e.code)).toBe('SCHEMA_INVALID');
  });

  it('the default Massive bound accepts the same valid JSON at exactly 4 MiB', async () => {
    const json = JSON.stringify(PAGE([ARTICLE_A]));
    const padding = MASSIVE_MAX_RESPONSE_BYTES - new TextEncoder().encode(json).byteLength;
    const connector = await massiveConnector(async () => responseWith({ body: bodyOf(json + ' '.repeat(padding)) }));
    expect(await connector.fetchBatch(NEWS_REQUEST() as never, await massiveMapping()).then(() => 'accepted', (e: { code?: string }) => e.code)).toBe('accepted');
  });

  it('a Massive status error does not read the body', async () => {
    const probe = newProbe();
    const connector = await massiveConnector(async () => responseWith({ status: 500, body: bodyOf('{}', probe) }));
    await connector.fetchBatch(NEWS_REQUEST() as never, await massiveMapping()).catch(() => undefined);
    expect(probe.reads).toBe(0);
  });

  it('a Massive success response with no body is refused, never read as empty', async () => {
    const connector = await massiveConnector(async () => responseWith({ body: undefined }));
    expect(await connector.fetchBatch(NEWS_REQUEST() as never, await massiveMapping()).catch((e: { code?: string }) => e.code)).toBe('SCHEMA_INVALID');
  });

  it('a Massive bound outside 1 byte to the 64 MiB ceiling is refused at construction', () => {
    expect(() => new MassiveNewsRestConnector({ secrets: { get: () => MASSIVE_SECRET }, fetch: async () => responseWith({}), caller: new ResilientCaller(MASSIVE_PROVIDER, {}), clock, maxResponseBytes: 0 })).toThrow(FinancialGatewayError);
    expect(() => new MassiveNewsRestConnector({ secrets: { get: () => MASSIVE_SECRET }, fetch: async () => responseWith({}), caller: new ResilientCaller(MASSIVE_PROVIDER, {}), clock, maxResponseBytes: 1.5 })).toThrow(FinancialGatewayError);
  });
});

describe('the generic REST connector requires an explicit bound (§17–§19)', () => {
  it('a connector without maxResponseBytes is refused at construction, before any request', () => {
    expect(() => new RestFinancialConnector(restOptions(async () => textResponse('{}'), undefined as never))).toThrow(FinancialGatewayError);
  });

  it('a bound of zero, a fraction or an infinite bound is refused at construction', () => {
    for (const bound of [0, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new RestFinancialConnector(restOptions(async () => textResponse('{}'), bound))).toThrow(FinancialGatewayError);
    }
  });

  it('a generic REST body over its bound is SCHEMA_INVALID', async () => {
    const gateway = await restGateway(async () => textResponse(JSON.stringify(FUNDAMENTALS_RAW)), 16);
    expect(await gateway.fetch(restRequest()).catch((e: { code?: string }) => e.code)).toBe('SCHEMA_INVALID');
  });

  it('a generic REST status error does not read the body', async () => {
    const probe = newProbe();
    const gateway = await restGateway(async () => responseWith({ status: 500, body: bodyOf('{}', probe) }), 1024);
    await gateway.fetch(restRequest()).catch(() => undefined);
    expect(probe.reads).toBe(0);
  });

  it('a generic REST success response with no body is SCHEMA_INVALID, never an empty object', async () => {
    const gateway = await restGateway(async () => responseWith({ body: undefined }), 1024);
    expect(await gateway.fetch(restRequest()).catch((e: { code?: string }) => e.code)).toBe('SCHEMA_INVALID');
  });

  it('a generic REST body that never completes is ended by the caller timeout', async () => {
    const gateway = await restGateway(async () => responseWith({ body: neverEndingBody() }), 1024, { timeoutMs: 30, maxAttempts: 1 });
    expect(await gateway.fetch(restRequest()).catch((e: { code?: string }) => e.code)).toBe('timeout');
  });
});

// ---- helpers ----------------------------------------------------------------------------------------------------------------------------

async function massiveMapping() {
  const registry = await massiveInstruments();
  return registry.mappingAt(NEWS_REQUEST().instrumentId, MASSIVE_PROVIDER, NEWS_REQUEST().asOf)!;
}

async function massiveConnector(fetchFn: FetchLike, options: { maxResponseBytes?: number } = {}) {
  return new MassiveNewsRestConnector({
    secrets: { get: (ref: string) => (ref === 'massive-api-key' ? MASSIVE_SECRET : undefined) },
    fetch: fetchFn,
    caller: new ResilientCaller(MASSIVE_PROVIDER, { timeoutMs: 1000, maxAttempts: 1 }, { now: () => 0, sleep: async () => undefined, random: () => 0.5 }),
    clock,
    ...options,
  });
}

function restOptions(fetchFn: FetchLike, maxResponseBytes: number) {
  return {
    connectorId: 'rest-1',
    provider: PROVIDER,
    baseUrl: 'https://api.example.invalid',
    credentialRef: 'rest-fixture-key',
    secrets: { get: (ref: string) => (ref === 'rest-fixture-key' ? 'sentinel-fixed' : undefined) },
    fetch: fetchFn,
    caller: new ResilientCaller(PROVIDER, { timeoutMs: 50, maxAttempts: 1 }, { now: () => 0, sleep: async () => undefined, random: () => 0.5 }),
    endpoints: { fundamentals: () => ({ path: '/v1/fundamentals', query: { symbol: 'AAPL' } }) },
    map: (_c: string, raw: unknown) => ({ candidate: raw, providerSymbol: 'AAPL' }),
    clock,
    maxResponseBytes,
  };
}

async function restGateway(fetchFn: FetchLike, maxResponseBytes: number, policy: { timeoutMs?: number; maxAttempts?: number } = {}) {
  const connector = new RestFinancialConnector({ ...restOptions(fetchFn, maxResponseBytes), caller: new ResilientCaller(PROVIDER, { timeoutMs: policy.timeoutMs ?? 50, maxAttempts: policy.maxAttempts ?? 1 }, { now: () => 0, sleep: async () => undefined, random: () => 0.5 }) });
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: 'rest-1', provider: PROVIDER, transport: 'rest', capabilities: ['fundamentals'], license: RESEARCH_ONLY, mode: 'RESEARCH' }, change());
  await registry.enable('rest-1', change());
  return new FinancialDataGateway({ registry, instruments: await instrumentRegistry(), connectors: [connector], clock });
}

function restRequest(requestId = 'r-bounded') {
  return { requestId, capability: 'fundamentals', connectorId: 'rest-1', asOf: T0, environment: 'research', instrumentId: AAPL_ID, currency: 'USD', period: '2025-Q4' };
}
