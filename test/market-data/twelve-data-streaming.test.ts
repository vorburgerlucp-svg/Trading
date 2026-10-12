// Twelve Data transport hardening (docs/TWELVE_DATA_STREAMING_HARDENING_V1.md). These tests state the streaming contract at the provider boundary: the body is
// read as a bounded stream, its bytes are counted, text() is never called, and chunking never changes a result.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstrumentRegistry } from '../../src/market-data/instrument-registry.js';
import { MarketDataError } from '../../src/market-data/market-data-provider.js';
import { MarketDataService } from '../../src/market-data/market-data-service.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import type { ProviderInstrumentMapping } from '../../src/market-data/market-data-types.js';
import type { FetchLike, HttpResponseLike, ResilienceDeps } from '../../src/market-data/providers/resilience.js';
import { TWELVE_DATA_MAX_RESPONSE_BYTES, TwelveDataMarketDataProvider, type TwelveDataOptions } from '../../src/market-data/providers/twelve-data.js';
import { parseUtc } from '../../src/market-data/time.js';
import { bodyOf, chunksOf, failingBody, neverEndingBody, newProbe, responseWith, type BodyProbe } from '../financial/http-body-fixtures.js';
import { AAPL } from './fixtures.js';

const KEY = 'test-key-123';
const enc = new TextEncoder();
const mapping: ProviderInstrumentMapping = { instrumentId: AAPL.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '2000-01-01T00:00:00Z' };
const barRequest = () => ({ instrument: AAPL, mapping, interval: '5m' as const, from: '2026-10-07T13:30:00Z', to: '2026-10-07T14:00:00Z', adjustment: 'raw' as const });
const meta = { symbol: 'AAPL', interval: '5min', currency: 'USD', exchange_timezone: 'America/New_York', exchange: 'NASDAQ', mic_code: 'XNAS', type: 'Common Stock' };
const bars = (count: number) => ({
  status: 'ok',
  meta,
  values: Array.from({ length: count }, (_, i) => ({ datetime: '2026-10-07 13:' + String(30 + 5 * i).padStart(2, '0') + ':00', open: '250.00', high: '250.00', low: '250.00', close: '250.10', volume: '1200' })),
});
const QUOTE = { symbol: 'AAPL', name: 'Apple Inc', mic_code: 'XNAS', currency: 'USD', timestamp: 1791358200, last_quote_at: 1791381420, open: '249.50', high: '251.00', low: '249.00', close: '250.40', volume: '1000000', previous_close: '249.80', is_market_open: true };
const SEARCH = { status: 'ok', data: [{ symbol: 'AAPL', instrument_name: 'Zürich Apple Inc', exchange: 'NASDAQ', mic_code: 'XNAS', exchange_timezone: 'America/New_York', instrument_type: 'Common Stock', country: 'United States', currency: 'USD' }] };
const SPLITS = { meta: { symbol: 'AAPL', currency: 'USD' }, splits: [{ date: '2020-08-31', from_factor: 1, to_factor: 4 }] };
const DIVIDENDS = { meta: { symbol: 'AAPL', currency: 'USD' }, dividends: [{ ex_date: '2026-08-11', amount: 0.26 }] };
const BODY_BY_PATH: Record<string, unknown> = { '/time_series': bars(6), '/quote': QUOTE, '/symbol_search': SEARCH, '/splits': SPLITS, '/dividends': DIVIDENDS };

/** A response whose streaming body is the text, in chunks of the given byte size (one chunk when none is given). */
function reply(text: string, options: { status?: number; headers?: Record<string, string>; chunk?: number; probe?: BodyProbe } = {}): HttpResponseLike {
  const parts = options.chunk ? chunksOf(text, options.chunk) : [enc.encode(text)];
  return responseWith({ status: options.status ?? 200, headers: options.headers ?? {}, body: bodyOf(parts, options.probe) });
}
const json = (body: unknown, options: Parameters<typeof reply>[1] = {}) => reply(JSON.stringify(body), options);

/** A JSON object of exactly the given byte length; the padding is insignificant whitespace. */
const padded = (total: number) => '{"data":[]' + ' '.repeat(total - 11) + '}';

/** Answers the calls in order. */
function sequence(...responses: HttpResponseLike[]): FetchLike {
  const queue = [...responses];
  return async () => queue.shift()!;
}

/** Counts the calls of a fetch that builds a new response each time. */
function counted(response: () => HttpResponseLike): { fetch: FetchLike; calls: () => number } {
  let calls = 0;
  return {
    fetch: async () => {
      calls++;
      return response();
    },
    calls: () => calls,
  };
}

function providerWith(fetch: FetchLike, options: { maxResponseBytes?: number; maxAttempts?: number } = {}) {
  let now = parseUtc('2026-10-07T13:57:30Z');
  const slept: number[] = [];
  const deps: ResilienceDeps = {
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    random: () => 0.5,
  };
  const config: TwelveDataOptions = {
    apiKey: KEY,
    environment: 'production',
    fetch,
    clock: () => new Date(now),
    deps,
    resilience: { timeoutMs: 50, maxAttempts: options.maxAttempts ?? 2 },
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
  };
  return { provider: new TwelveDataMarketDataProvider(config), slept };
}

/** Resolves to the rejection, or null when the promise resolves. */
const failureOf = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the body is read as a bounded stream, never as text()', () => {
  it('a success response without a readable body fails closed; the legacy text() is never called', async () => {
    const legacy = vi.fn(async () => JSON.stringify(bars(1)));
    const response = { ...responseWith({ status: 200 }), text: legacy } as unknown as HttpResponseLike;
    const { provider } = providerWith(async () => response);
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'schema_invalid', retryable: false });
    expect(legacy).not.toHaveBeenCalled();
  });

  it('the response shape has no text() member, so a whole-body fallback does not compile', () => {
    // @ts-expect-error text() is not part of HttpResponseLike: a whole-body read cannot be written against it
    const shape: HttpResponseLike = { status: 200, headers: { get: () => null }, text: async () => '{}' };
    expect(shape.status).toBe(200);
  });

  it('the default production fetch hands the native body to the reader; Response.text() is never called', async () => {
    const text = vi.spyOn(Response.prototype, 'text');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(QUOTE), { status: 200 }));
    const provider = TwelveDataMarketDataProvider.publicDemo({ clock: () => new Date('2026-10-07T13:57:30Z'), deps: { now: () => 0, sleep: async () => undefined, random: () => 0.5 } });
    const { quote } = await provider.getQuote({ instrument: AAPL, mapping });
    expect(quote.last.toString()).toBe('250.4');
    expect(text).not.toHaveBeenCalled();
  });

  it('a native Response returned by an injected fetch is read through its stream; Response.text() is never called', async () => {
    const text = vi.spyOn(Response.prototype, 'text');
    const { provider } = providerWith(async () => new Response(JSON.stringify(QUOTE), { status: 200 }));
    const { quote } = await provider.getQuote({ instrument: AAPL, mapping });
    expect(quote.last.toString()).toBe('250.4');
    expect(text).not.toHaveBeenCalled();
  });
});

describe('the byte bound', () => {
  it('the default bound is 30,000,000 bytes, below the 64 MiB ceiling', () => {
    expect(TWELVE_DATA_MAX_RESPONSE_BYTES).toBe(30_000_000);
  });

  it('a declared Content-Length over the default bound is refused before any body byte is read', async () => {
    const probe = newProbe();
    const { provider } = providerWith(async () => reply('{}', { headers: { 'content-length': '30000001' }, probe }));
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'schema_invalid', retryable: false });
    expect(probe.reads).toBe(0);
  });

  it('a body of exactly the configured bound is accepted, and one byte more is refused', async () => {
    const exact = providerWith(async () => reply(padded(32)), { maxResponseBytes: 32 });
    expect(await exact.provider.searchInstruments('AAPL')).toEqual([]);
    const over = providerWith(async () => reply(padded(33)), { maxResponseBytes: 32 });
    expect(await failureOf(over.provider.searchInstruments('AAPL'))).toMatchObject({ code: 'schema_invalid', retryable: false });
  });

  it('a stream that runs past the bound is refused; the reader is cancelled and released, and no further chunk is read', async () => {
    const probe = newProbe();
    const chunks = Array.from({ length: 5 }, () => new Uint8Array(20));
    const { provider } = providerWith(async () => responseWith({ status: 200, body: bodyOf(chunks, probe) }), { maxResponseBytes: 32 });
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'schema_invalid' });
    expect(probe.reads).toBe(2);
    expect(probe.cancels).toBe(1);
    expect(probe.releases).toBe(1);
  });

  it('a body larger than its declared Content-Length is still refused: an understated header cannot pass an oversize stream', async () => {
    const { provider } = providerWith(async () => reply(padded(33), { headers: { 'content-length': '4' } }), { maxResponseBytes: 32 });
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'schema_invalid' });
  });

  it('a malformed Content-Length is schema_invalid, for every malformed form', async () => {
    for (const value of ['+4', '04', '4 ', 'abc', '-1', '1e3']) {
      const { provider } = providerWith(async () => json(bars(1), { headers: { 'content-length': value } }));
      expect(await failureOf(provider.getHistoricalBars(barRequest())), value).toMatchObject({ code: 'schema_invalid', retryable: false });
    }
  });

  it('the bound counts bytes, not characters: a multibyte body over its byte count is refused even when its characters fit', async () => {
    const text = '{"data":[],"note":"' + 'ü'.repeat(20) + '"}';
    const bytes = enc.encode(text).byteLength;
    expect(bytes).toBeGreaterThan(text.length);
    const characterBound = providerWith(async () => reply(text), { maxResponseBytes: text.length });
    expect(await failureOf(characterBound.provider.searchInstruments('AAPL'))).toMatchObject({ code: 'schema_invalid' });
    const byteBound = providerWith(async () => reply(text), { maxResponseBytes: bytes });
    expect(await byteBound.provider.searchInstruments('AAPL')).toEqual([]);
  });

  it('an oversize 503 is schema_invalid, regardless of its status', async () => {
    const counter = counted(() => reply(padded(33), { status: 503 }));
    const { provider } = providerWith(counter.fetch, { maxResponseBytes: 32, maxAttempts: 2 });
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'schema_invalid', retryable: false });
    expect(counter.calls()).toBe(1);
  });

  it('an invalid response bound is refused at construction with not_configured, and the ceiling itself is accepted', () => {
    for (const bound of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 26 + 1, '32']) {
      let thrown: unknown = null;
      try {
        new TwelveDataMarketDataProvider({ apiKey: KEY, environment: 'production', maxResponseBytes: bound as number });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, String(bound)).toBeInstanceOf(MarketDataError);
      expect(thrown, String(bound)).toMatchObject({ code: 'not_configured' });
    }
    expect(() => new TwelveDataMarketDataProvider({ apiKey: KEY, environment: 'production', maxResponseBytes: 2 ** 26 })).not.toThrow();
  });
});

describe('the body is parsed and classified as before', () => {
  it('a missing body on a 200 is refused, never read as empty, and text() is never called', async () => {
    const { provider } = providerWith(async () => responseWith({ status: 200, body: undefined }));
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'schema_invalid', retryable: false });
  });

  it('malformed UTF-8 is schema_invalid, with no retry and no domain output', async () => {
    const counter = counted(() => responseWith({ status: 200, body: bodyOf([new Uint8Array([0x7b, 0xff, 0x7d])]) }));
    const { provider } = providerWith(counter.fetch);
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'schema_invalid', retryable: false });
    expect(counter.calls()).toBe(1);
  });

  it('a UTF-8 sequence split across chunks decodes exactly', async () => {
    const { provider } = providerWith(async () => json(SEARCH, { chunk: 1 }));
    const [candidate] = await provider.searchInstruments('AAPL');
    expect(candidate!.name).toBe('Zürich Apple Inc');
  });

  it('a 200 whose body is not JSON is schema_invalid', async () => {
    const { provider } = providerWith(async () => reply('not json'));
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'schema_invalid', retryable: false });
  });

  it('an HTTP 200 provider error object split across chunks maps to auth_failed, once', async () => {
    const counter = counted(() => json({ code: 401, message: 'Invalid API key', status: 'error' }, { chunk: 3 }));
    const { provider } = providerWith(counter.fetch);
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'auth_failed', retryable: false });
    expect(counter.calls()).toBe(1);
  });

  it('an HTTP 200 provider error object with code 429 split across chunks is rate_limited, with the fallback delay', async () => {
    const { provider, slept } = providerWith(sequence(json({ code: 429, message: 'limit', status: 'error' }, { chunk: 4 }), json(bars(1), { chunk: 4 })));
    expect((await provider.getHistoricalBars(barRequest())).bars).toHaveLength(1);
    expect(slept).toEqual([15_000]);
  });

  it('an HTTP 403 JSON error split across chunks is not_entitled', async () => {
    const { provider } = providerWith(async () => json({ code: 403, message: 'upgrade your plan', status: 'error' }, { status: 403, chunk: 2 }));
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'not_entitled', retryable: false });
  });

  it('an API key split across chunks is redacted in the provider message', async () => {
    const { provider } = providerWith(async () => json({ code: 401, message: 'Invalid API key ' + KEY + ' provided', status: 'error' }, { chunk: 5 }));
    const error = (await failureOf(provider.getHistoricalBars(barRequest()))) as MarketDataError;
    expect(error).toMatchObject({ code: 'auth_failed' });
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(KEY);
  });

  it('a non-JSON 503 stays provider_unavailable and is retried', async () => {
    const counter = counted(() => reply('busy', { status: 503 }));
    const { provider } = providerWith(counter.fetch, { maxAttempts: 2 });
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(counter.calls()).toBe(2);
  });

  it('an empty 503 (no body) stays provider_unavailable: the status decides when an error response has no body', async () => {
    const counter = counted(() => responseWith({ status: 503, body: null }));
    const { provider } = providerWith(counter.fetch, { maxAttempts: 2 });
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(counter.calls()).toBe(2);
  });

  it('a 503 with malformed UTF-8 stays provider_unavailable: an unusable error body does not override the status', async () => {
    const counter = counted(() => responseWith({ status: 503, body: bodyOf([new Uint8Array([0xff])]) }));
    const { provider } = providerWith(counter.fetch, { maxAttempts: 2 });
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'provider_unavailable', retryable: true });
  });

  it('a 429 with no body keeps its Retry-After', async () => {
    const { provider, slept } = providerWith(sequence(responseWith({ status: 429, headers: { 'retry-after': '7' }, body: null }), json(bars(1))));
    expect((await provider.getHistoricalBars(barRequest())).bars).toHaveLength(1);
    expect(slept).toEqual([7_000]);
  });

  it('a 503 is retried after its backoff, as before', async () => {
    const { provider, slept } = providerWith(sequence(reply('busy', { status: 503 }), json(bars(1))));
    await provider.getHistoricalBars(barRequest());
    expect(slept).toEqual([375]);
  });
});

describe('a body that stalls or fails is classified by the caller, not as schema_invalid', () => {
  it('a body that never completes ends as timeout, and the existing retry policy applies', async () => {
    const counter = counted(() => responseWith({ status: 200, body: neverEndingBody() }));
    const { provider } = providerWith(counter.fetch, { maxAttempts: 2 });
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'timeout', retryable: true });
    expect(counter.calls()).toBe(2);
  });

  it('an abort raised while the body is read is a timeout, never schema_invalid', async () => {
    const abort = Object.assign(new Error('the request was aborted'), { name: 'AbortError' });
    const counter = counted(() => responseWith({ status: 200, body: failingBody(abort) }));
    const { provider } = providerWith(counter.fetch, { maxAttempts: 2 });
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'timeout', retryable: true });
    expect(counter.calls()).toBe(2);
  });

  it('a network termination mid-body stays provider_unavailable, and is retried', async () => {
    const counter = counted(() => responseWith({ status: 200, body: failingBody(new TypeError('fetch failed'), [enc.encode('{"meta"')]) }));
    const { provider } = providerWith(counter.fetch, { maxAttempts: 2 });
    expect(await failureOf(provider.getHistoricalBars(barRequest()))).toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(counter.calls()).toBe(2);
  });

  it('a stream failure that is not a network error is rethrown unchanged, as before', async () => {
    const { provider } = providerWith(async () => responseWith({ status: 200, body: failingBody(new Error('boom')) }));
    const error = await failureOf(provider.getHistoricalBars(barRequest()));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MarketDataError);
    expect((error as Error).message).toBe('boom');
  });
});

describe('one chunk and fragmented chunks give the same result', () => {
  async function outputsOf(chunk?: number) {
    const fetch: FetchLike = async (url) => json(BODY_BY_PATH[new URL(url).pathname], chunk === undefined ? {} : { chunk });
    const { provider } = providerWith(fetch);
    return {
      bars: (await provider.getHistoricalBars(barRequest())).bars,
      quote: (await provider.getQuote({ instrument: AAPL, mapping })).quote,
      search: await provider.searchInstruments('AAPL'),
      corporate: (await provider.getCorporateActions!({ instrument: AAPL, mapping, from: '2020-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' })).actions,
    };
  }

  it('bars, quote, symbol search, splits and dividends are deep-equal for one chunk, 7-byte chunks and one-byte chunks', async () => {
    const whole = await outputsOf();
    expect(whole.bars).toHaveLength(6);
    expect(whole.search[0]!.name).toBe('Zürich Apple Inc');
    expect(whole.corporate.map((a) => a.type)).toEqual(['split', 'cash_dividend']);
    expect(await outputsOf(7)).toEqual(whole);
    expect(await outputsOf(1)).toEqual(whole);
  });

  async function storedRun(chunk?: number) {
    const human = { kind: 'human' as const, id: 'luc' };
    const registry = await InstrumentRegistry.open();
    await registry.register(AAPL, { at: '2026-01-01T00:00:00Z', by: human, reason: 'setup' });
    await registry.addMapping(mapping, { at: '2026-01-01T00:00:00Z', by: human, reason: 'setup' });
    const { provider } = providerWith(async () => json(bars(6), chunk === undefined ? {} : { chunk }));
    const service = new MarketDataService({ registry, store: new InMemoryMarketDataStore(), providers: [provider], clock: () => new Date('2026-10-08T00:00:00Z') });
    const backfill = await service.backfillBars({ instrumentId: AAPL.instrumentId, provider: 'twelvedata', interval: '5m', adjustment: 'raw', from: '2026-10-07T13:30:00Z', to: '2026-10-07T14:00:00Z' });
    const series = await service.readSeries({ instrumentId: AAPL.instrumentId, source: 'twelvedata:time_series:production', interval: '5m', session: 'regular', adjustment: 'raw', asOf: '2026-10-08T00:00:00Z', useCase: 'analysis' });
    return { summaries: backfill.windows.map((w) => w.summary), series };
  }

  it('the stored records, their content hashes and the read-back series are identical for one chunk and fragmented chunks', async () => {
    const whole = await storedRun();
    expect(await storedRun(3)).toEqual(whole);
    expect(whole.series.bars).toHaveLength(6);
    expect(whole.series.bars.every((bar) => bar.contentHash.length > 0)).toBe(true);
  });
});
