import { describe, expect, it } from 'vitest';
import { MassiveNewsRestConnector } from '../../src/financial/massive-news-connector.js';
import { FinancialDataGateway } from '../../src/financial/financial-gateway.js';
import { FinancialConnectorRegistry } from '../../src/financial/financial-registry.js';
import { ResilientCaller } from '../../src/market-data/providers/resilience.js';
import { change, UNREVIEWED } from './fixtures.js';
import { ARTICLE_A, MASSIVE_CONNECTOR, MASSIVE_PROVIDER, MASSIVE_SECRET, NEWS_REQUEST, json, massiveInstruments, scriptedFetch, type Answer } from './massive-fixtures.js';

// docs/MASSIVE_NEWS_CONNECTOR_V1.md §5 (timestamp precision) and §5 (empty pages). The schema follows the provider's documented contract without weakening
// NEXUS validation: status and results are optional, but whatever is present must be exact; timestamps follow RFC 3339 UTC; NEXUS keeps milliseconds.

const clock = () => new Date('2026-06-01T10:00:00.000Z');
const noSleep = { now: () => 0, sleep: async () => undefined, random: () => 0.5 };

async function batchFor(answer: Answer, limit?: number) {
  const http = scriptedFetch([answer]);
  const connector = new MassiveNewsRestConnector({
    secrets: { get: (ref: string) => (ref === 'massive-api-key' ? MASSIVE_SECRET : undefined) },
    fetch: http.fetch,
    caller: new ResilientCaller(MASSIVE_PROVIDER, { timeoutMs: 1000, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2, rateLimitFallbackMs: 1 }, noSleep),
    clock,
    ...(limit !== undefined ? { limit } : {}),
  });
  const registry = await FinancialConnectorRegistry.open();
  await registry.register({ connectorId: MASSIVE_CONNECTOR, provider: MASSIVE_PROVIDER, transport: 'rest', capabilities: ['news'], license: UNREVIEWED, mode: 'RESEARCH' }, change());
  await registry.enable(MASSIVE_CONNECTOR, change());
  const gateway = new FinancialDataGateway({ registry, instruments: await massiveInstruments(), connectors: [connector], clock });
  return { batch: () => gateway.fetchBatch(NEWS_REQUEST()), http };
}

const article = (published_utc: string) => ({ ...ARTICLE_A, published_utc });
const MASSIVE_NEXT = 'https://api.massive.com/v2/reference/news?cursor=abc';

describe('optional status (§5): present must be OK, absent is allowed on HTTP 200', () => {
  it('HTTP 200 with status omitted and valid results is accepted', async () => {
    const { batch } = await batchFor(json(200, { results: [ARTICLE_A] }));
    expect((await batch()).evidence).toHaveLength(1);
  });

  it('HTTP 200 with status OK is accepted', async () => {
    const { batch } = await batchFor(json(200, { status: 'OK', results: [ARTICLE_A] }));
    expect((await batch()).evidence).toHaveLength(1);
  });

  it('a status null inside HTTP 200 is refused: present means it must be OK', async () => {
    const { batch } = await batchFor(json(200, { status: null, results: [ARTICLE_A] }));
    await expect(batch()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  });

  it('an error status inside HTTP 200 is refused', async () => {
    const { batch } = await batchFor(json(200, { status: 'ERROR', results: [ARTICLE_A] }));
    await expect(batch()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  });
});

describe('optional results (§5): an empty page is a valid empty batch; malformed results is never empty', () => {
  it('HTTP 200, status OK, results absent: a valid empty batch, complete', async () => {
    const { batch } = await batchFor(json(200, { status: 'OK' }));
    const result = await batch();
    expect(result.evidence).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('HTTP 200, status and results absent: a valid empty batch', async () => {
    const { batch } = await batchFor(json(200, {}));
    expect((await batch()).evidence).toEqual([]);
  });

  it('results absent with a valid Massive next_url: an empty batch, incomplete, and next_url is not followed', async () => {
    const { batch, http } = await batchFor(json(200, { status: 'OK', next_url: MASSIVE_NEXT }));
    const result = await batch();
    expect(result.evidence).toEqual([]);
    expect(result.complete).toBe(false);
    expect(http.calls).toHaveLength(1);
  });

  it('results absent with a next_url on a foreign host is refused, and not followed', async () => {
    const { batch, http } = await batchFor(json(200, { status: 'OK', next_url: 'https://attacker.example.invalid/steal' }));
    await expect(batch()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(http.calls).toHaveLength(1);
  });

  it('results present as null is refused, never read as an empty page', async () => {
    const { batch } = await batchFor(json(200, { status: 'OK', results: null }));
    await expect(batch()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  });

  it('results present as an object is refused, never read as an empty page', async () => {
    const { batch } = await batchFor(json(200, { status: 'OK', results: { id: 'x' } }));
    await expect(batch()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  });
});

describe('RFC 3339 fraction precision (§5): accepted forms all parse, and NEXUS keeps milliseconds', () => {
  const accepted: Array<[string, string]> = [
    ['2026-01-01T12:00:00Z', '2026-01-01T12:00:00.000Z'],
    ['2026-01-01T12:00:00.1Z', '2026-01-01T12:00:00.100Z'],
    ['2026-01-01T12:00:00.123Z', '2026-01-01T12:00:00.123Z'],
    ['2026-01-01T12:00:00.123456Z', '2026-01-01T12:00:00.123Z'],
    ['2026-01-01T12:00:00.123456789Z', '2026-01-01T12:00:00.123Z'],
  ];
  for (const [input, expected] of accepted) {
    it('accepts ' + input + ' and stores it as ' + expected, async () => {
      const { batch } = await batchFor(json(200, PAGE_OF(article(input))));
      const [e] = (await batch()).evidence;
      expect(e!.providerPublishedAt).toBe(expected);
    });
  }

  it('truncates, never rounds: .123999Z is .123, and the sub-millisecond digits are not retained', async () => {
    const { batch } = await batchFor(json(200, PAGE_OF(article('2026-01-01T12:00:00.123999Z'))));
    const [e] = (await batch()).evidence;
    expect(e!.providerPublishedAt).toBe('2026-01-01T12:00:00.123Z');
  });

  it('two timestamps that differ only below one millisecond are the same NEXUS instant (the documented V1 policy)', async () => {
    const first = await batchFor(json(200, PAGE_OF(article('2026-01-01T12:00:00.123456Z'))));
    const second = await batchFor(json(200, PAGE_OF(article('2026-01-01T12:00:00.123789Z'))));
    const [a] = (await first.batch()).evidence;
    const [b] = (await second.batch()).evidence;
    expect(a!.providerPublishedAt).toBe(b!.providerPublishedAt);
  });
});

describe('invalid timestamps (§5): still refused', () => {
  const refused: Array<[string, string]> = [
    ['a local time without Z', '2026-01-01T12:00:00'],
    ['an offset instead of UTC', '2026-01-01T12:00:00+02:00'],
    ['an impossible day (30 February)', '2026-02-30T12:00:00Z'],
    ['an impossible hour', '2026-01-01T25:00:00Z'],
    ['an impossible minute', '2026-01-01T12:60:00Z'],
    ['a leap second', '2026-01-01T12:00:60Z'],
    ['an empty fraction', '2026-01-01T12:00:00.Z'],
    ['a fraction longer than nine digits', '2026-01-01T12:00:00.1234567890Z'],
    ['a year before 0100', '0050-01-01T12:00:00Z'],
    ['an empty string', ''],
    ['an RFC 822 date', 'Thu, 01 Jan 2026 12:00:00 GMT'],
    ['a date without a time', '2026-01-01'],
  ];
  for (const [label, value] of refused) {
    it('refuses ' + label, async () => {
      const { batch } = await batchFor(json(200, PAGE_OF(article(value))));
      await expect(batch()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    });
  }
});

/** A page with the given articles, status OK. */
function PAGE_OF(...results: unknown[]) {
  return { status: 'OK', request_id: 'req-1', count: results.length, results };
}
