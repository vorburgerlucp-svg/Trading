import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { RestFinancialConnector } from '../../src/financial/rest-transport.js';
import { FinancialGatewayError } from '../../src/financial/financial-types.js';
import { ResilientCaller, type FetchLike, type HttpResponseLike, type ResiliencePolicy } from '../../src/market-data/providers/resilience.js';
import { AAPL_ID, change, FUNDAMENTALS_RAW, instrumentRegistry, PROVIDER, RESEARCH_ONLY, T0 } from './fixtures.js';
import { bodyOf, responseWith } from './http-body-fixtures.js';

// docs/FINANCIAL_CONNECTOR_GATEWAY_V1.md §10, §11, §14, §21, §22. REST shares ResilientCaller with the market-data providers: retries are bounded,
// Retry-After is honoured, the circuit breaker stops calls, and the secret never reaches a URL, an error or evidence. No network: fetch is injected.

// A runtime sentinel, not a key: it proves redaction without putting a token-shaped literal into Git.
const SECRET = 'sentinel-' + randomUUID();
const clock = () => new Date(T0);
const sleeps: number[] = [];
const deps = { now: () => 0, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5 };

beforeEach(() => {
  sleeps.length = 0;
});

function response(status: number, body: string, headers: Record<string, string> = {}): HttpResponseLike {
  return responseWith({ status, headers, body: bodyOf(body) });
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

async function gatewayWith(fetchFn: FetchLike, policy: Partial<ResiliencePolicy> = {}) {
  const caller = new ResilientCaller(PROVIDER, { timeoutMs: 50, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, rateLimitFallbackMs: 1, ...policy }, deps);
  const connector = new RestFinancialConnector({
    connectorId: 'rest-1',
    provider: PROVIDER,
    baseUrl: 'https://api.example.invalid',
    credentialRef: 'rest-fixture-key',
    secrets: { get: (ref: string) => (ref === 'rest-fixture-key' ? SECRET : undefined) },
    fetch: fetchFn,
    caller,
    endpoints: { fundamentals: () => ({ path: '/v1/fundamentals', query: { symbol: 'AAPL' } }) },
    map: (_capability: string, raw: unknown) => ({ candidate: raw, providerSymbol: 'AAPL' }),
    clock,
    maxResponseBytes: 1024 * 1024,
  });
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: 'rest-1', provider: PROVIDER, transport: 'rest', capabilities: ['fundamentals'], license: RESEARCH_ONLY, mode: 'RESEARCH' }, change());
  await registry.enable('rest-1', change());
  return new FinancialDataGateway({ registry, instruments: await instrumentRegistry(), connectors: [connector], clock });
}

const request = (requestId = 'r-rest') => ({
  requestId,
  capability: 'fundamentals',
  connectorId: 'rest-1',
  asOf: T0,
  environment: 'research',
  instrumentId: AAPL_ID,
  currency: 'USD',
  period: '2025-Q4',
});

describe('REST schema and resilience (§10, §14, §20)', () => {
  it('a body that is not JSON fails with SCHEMA_INVALID and is not retried', async () => {
    let calls = 0;
    const gateway = await gatewayWith(async () => {
      calls++;
      return response(200, '<html>not json</html>');
    });
    await expect(gateway.fetch(request())).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(calls).toBe(1);
  });

  it('a timeout is retried a bounded number of times, then reported as timeout', async () => {
    let calls = 0;
    const gateway = await gatewayWith(() => {
      calls++;
      return new Promise<HttpResponseLike>(() => undefined);
    }, { timeoutMs: 5, maxAttempts: 2 });
    await expect(gateway.fetch(request())).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it('a rate limit honours Retry-After (seconds) before the retry, then succeeds', async () => {
    let calls = 0;
    const gateway = await gatewayWith(async () => {
      calls++;
      return calls === 1 ? response(429, '{}', { 'retry-after': '2' }) : response(200, JSON.stringify(FUNDAMENTALS_RAW));
    });
    const e = await gateway.fetch(request());
    expect(e.capability).toBe('fundamentals');
    expect(calls).toBe(2);
    expect(sleeps).toContain(2000);
  });

  it('the circuit breaker opens after repeated transient failures, and then sends no request', async () => {
    let calls = 0;
    const gateway = await gatewayWith(async () => {
      calls++;
      return response(503, 'down');
    }, { maxAttempts: 1, circuitFailureThreshold: 3 });
    for (let i = 0; i < 3; i++) await expect(gateway.fetch(request('r-' + i))).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(gateway.fetch(request('r-open'))).rejects.toMatchObject({ code: 'circuit_open' });
    expect(calls).toBe(3);
  });

  it('a 400 is classified as bad_request and is not retried', async () => {
    let calls = 0;
    const gateway = await gatewayWith(async () => {
      calls++;
      return response(400, 'bad');
    });
    await expect(gateway.fetch(request())).rejects.toMatchObject({ code: 'bad_request', retryable: false });
    expect(calls).toBe(1);
  });
});

describe('secrets never leave the transport (§11, §21)', () => {
  it('the secret goes in the Authorization header only, never in the URL', async () => {
    const seen: Array<{ url: string; auth: string }> = [];
    const gateway = await gatewayWith(async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization ?? '' });
      return response(200, JSON.stringify(FUNDAMENTALS_RAW));
    });
    await gateway.fetch(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).not.toContain(SECRET);
    expect(seen[0]!.auth).toBe('Bearer ' + SECRET);
  });

  it('an unauthorized answer that echoes the secret does not leak it into the error', async () => {
    const gateway = await gatewayWith(async () => response(401, 'denied for token ' + SECRET));
    const err = await gateway.fetch(request()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'auth_failed' });
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it('a successful call returns evidence that never contains the secret', async () => {
    const gateway = await gatewayWith(async () => response(200, JSON.stringify(FUNDAMENTALS_RAW)));
    const e = await gateway.fetch(request());
    expect(JSON.stringify(e)).not.toContain(SECRET);
  });

  it('a credential reference that is not a plain configuration name is refused at construction', () => {
    const err = thrownBy(() => new RestFinancialConnector({
      connectorId: 'rest-1',
      provider: PROVIDER,
      baseUrl: 'https://api.example.invalid',
      credentialRef: 'Bad Ref!',
      secrets: { get: () => undefined },
      fetch: async () => response(200, '{}'),
      caller: new ResilientCaller(PROVIDER, {}, deps),
      endpoints: {},
      map: () => ({ candidate: {} }),
      clock,
      maxResponseBytes: 1024,
    }));
    expect(err).toBeInstanceOf(FinancialGatewayError);
  });
});
