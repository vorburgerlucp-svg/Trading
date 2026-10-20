// O22 B8: the currency of a Twelve Data crypto pair from Twelve Data's reference data, GET /cryptocurrencies.
// The live answer for ETH/USD (docs/evidence/O22_twelvedata_cryptocurrencies_ETH_USD_2026-10-19.json) is used as it is; every other
// HTTP answer is a TEST DOUBLE shaped after the official documentation, with synthetic numbers. No network.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { MarketDataError } from '../../src/market-data/market-data-provider.js';
import { MarketDataService } from '../../src/market-data/market-data-service.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import type { Instrument, ProviderInstrumentMapping } from '../../src/market-data/market-data-types.js';
import type { FetchLike, ResilienceDeps } from '../../src/market-data/providers/resilience.js';
import { CRYPTO_REFERENCE_TTL_MS, TwelveDataMarketDataProvider } from '../../src/market-data/providers/twelve-data.js';
import { CRYPTO_REFERENCE_SOURCE, TWELVE_DATA_CURRENCY_NAMES, TWELVE_DATA_CURRENCY_NAMES_VERSION, resolveCryptoQuoteCurrency } from '../../src/market-data/providers/twelve-data-crypto-reference.js';
import { parseCryptocurrencies, type TdCryptoPair } from '../../src/market-data/providers/twelve-data-schema.js';
import { InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { QuantService } from '../../src/quant/quant-service.js';
import { InMemoryQuantRunStore } from '../../src/quant/quant-run-store.js';
import { PortfolioKillSwitchStore } from '../../src/safety/portfolio-kill-switch-store.js';
import { createRuntimeServices } from '../../src/runtime/services.js';
import { bodyOf, responseWith } from '../financial/http-body-fixtures.js';

const EVIDENCE = 'docs/evidence/O22_twelvedata_cryptocurrencies_ETH_USD_2026-10-19.json';
const LIVE_RESPONSE = (JSON.parse(readFileSync(EVIDENCE, 'utf8')) as { response: Record<string, unknown> }).response;

const ETH_USD: Instrument = Object.freeze({ instrumentId: 'ins_test_eth_usd', assetClass: 'crypto', symbol: 'ETH/USD', currency: 'USD', timezone: 'UTC', tradingCalendar: '24x7', active: true });
const MAPPING: ProviderInstrumentMapping = { instrumentId: ETH_USD.instrumentId, provider: 'twelvedata', providerSymbol: 'ETH/USD', validFrom: '2000-01-01T00:00:00Z' };
const T0 = Date.parse('2026-10-19T12:00:00.000Z');

function pair(over: Partial<TdCryptoPair> = {}): TdCryptoPair {
  return { symbol: 'ETH/USD', currencyBase: 'Ethereum', currencyQuote: 'US Dollar', availableExchanges: ['Binance', 'Bitfinex', 'Huobi'], ...over };
}

function quoteBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { symbol: 'ETH/USD', name: 'Ethereum US Dollar', exchange: 'Binance', datetime: '2026-10-19', timestamp: 1792368000, last_quote_at: 1792411140, open: '2400.10', high: '2440.00', low: '2390.00', close: '2427.58', previous_close: '2401.00', is_market_open: true };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

type Route = { status?: number; body: unknown };

/** A provider whose HTTP answers are chosen by path; it counts every request. The clock can be moved. */
function harness(routes: Record<string, Route | (() => Route)>) {
  const calls: URL[] = [];
  let nowMs = T0;
  const fetch: FetchLike = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const route = routes[u.pathname];
    const r = typeof route === 'function' ? route() : route ?? { status: 404, body: { status: 'error', code: 404, message: 'not found' } };
    return responseWith({ status: r.status ?? 200, body: bodyOf(JSON.stringify(r.body)) });
  };
  const deps: ResilienceDeps = { now: () => nowMs, sleep: async () => undefined, random: () => 0.5 };
  const p = new TwelveDataMarketDataProvider({ apiKey: 'test-key-123', environment: 'production', fetch, clock: () => new Date(nowMs), deps });
  return { p, calls, paths: () => calls.map((c) => c.pathname), advance: (ms: number) => { nowMs += ms; } };
}

describe('O22 /cryptocurrencies reference: parsing and resolution', () => {
  it('the live answer for ETH/USD resolves to USD through the reviewed name table, with its origin', () => {
    const pairs = parseCryptocurrencies(LIVE_RESPONSE);
    expect(pairs).toEqual([pair()]);
    const r = resolveCryptoQuoteCurrency(pairs, 'ETH/USD', 'Binance', T0);
    expect(r).toEqual({ kind: 'resolved', currency: 'USD', origin: { kind: 'reference', source: CRYPTO_REFERENCE_SOURCE, stated: 'US Dollar', rule: TWELVE_DATA_CURRENCY_NAMES_VERSION, retrievedAt: '2026-10-19T12:00:00.000Z' } });
  });

  it('the name table is frozen and holds exactly the one reviewed entry', () => {
    expect(Object.isFrozen(TWELVE_DATA_CURRENCY_NAMES)).toBe(true);
    expect(TWELVE_DATA_CURRENCY_NAMES).toEqual({ 'US Dollar': 'USD' });
  });

  it('only the row of the requested symbol counts; none is NO_REFERENCE, two are AMBIGUOUS_REFERENCE', () => {
    const others = [pair({ symbol: 'ETH/EUR', currencyQuote: 'Euro' }), pair({ symbol: 'ETH/BTC', currencyQuote: 'Bitcoin' })];
    expect(resolveCryptoQuoteCurrency([...others, pair()], 'ETH/USD', undefined, T0)).toMatchObject({ kind: 'resolved', currency: 'USD' });
    expect(resolveCryptoQuoteCurrency(others, 'ETH/USD', undefined, T0)).toEqual({ kind: 'unresolved', reason: 'NO_REFERENCE' });
    expect(resolveCryptoQuoteCurrency([], 'ETH/USD', undefined, T0)).toEqual({ kind: 'unresolved', reason: 'NO_REFERENCE' });
    expect(resolveCryptoQuoteCurrency([pair(), pair({ currencyQuote: 'Euro' })], 'ETH/USD', undefined, T0)).toEqual({ kind: 'unresolved', reason: 'AMBIGUOUS_REFERENCE' });
    expect(resolveCryptoQuoteCurrency([pair(), pair()], 'ETH/USD', undefined, T0)).toEqual({ kind: 'unresolved', reason: 'AMBIGUOUS_REFERENCE' });
  });

  it('an unknown currency name gives no currency: no near match, no case folding, no guessing', () => {
    for (const name of ['Euro', 'US dollar', 'US Dollars', 'United States Dollar', 'Dollar', '']) {
      expect(resolveCryptoQuoteCurrency([pair({ currencyQuote: name })], 'ETH/USD', undefined, T0)).toEqual({ kind: 'unresolved', reason: 'UNKNOWN_CURRENCY_NAME' });
    }
  });

  it('an ISO code in currency_quote is used as it is, and the rule says so', () => {
    expect(resolveCryptoQuoteCurrency([pair({ currencyQuote: 'USD' })], 'ETH/USD', undefined, T0)).toMatchObject({ kind: 'resolved', currency: 'USD', origin: { rule: 'iso_code', stated: 'USD' } });
  });

  it('neither the symbol nor currency_base is ever read for the currency', () => {
    expect(resolveCryptoQuoteCurrency([pair({ currencyBase: 'US Dollar', currencyQuote: 'Ethereum' })], 'ETH/USD', undefined, T0)).toEqual({ kind: 'unresolved', reason: 'UNKNOWN_CURRENCY_NAME' });
  });

  it('a known venue must be listed for the pair', () => {
    expect(resolveCryptoQuoteCurrency([pair()], 'ETH/USD', 'Coinbase Pro', T0)).toEqual({ kind: 'unresolved', reason: 'EXCHANGE_NOT_LISTED' });
    expect(resolveCryptoQuoteCurrency([pair()], 'ETH/USD', 'Huobi', T0)).toMatchObject({ kind: 'resolved', currency: 'USD' });
  });

  it('the parser is strict: an error status, a missing field or a wrong type is schema_invalid', () => {
    expect(() => parseCryptocurrencies({ status: 'error', data: [] })).toThrow(MarketDataError);
    expect(() => parseCryptocurrencies({ status: 'ok', data: [{ symbol: 'ETH/USD', currency_base: 'Ethereum', available_exchanges: [] }] })).toThrow(MarketDataError);
    expect(() => parseCryptocurrencies({ status: 'ok', data: [{ symbol: 'ETH/USD', currency_base: 'Ethereum', currency_quote: 1, available_exchanges: [] }] })).toThrow(MarketDataError);
    expect(() => parseCryptocurrencies({ status: 'ok', data: [{ ...pair(), available_exchanges: 'Binance' }] })).toThrow(MarketDataError);
  });
});

describe('O22 crypto quote currency through the provider', () => {
  it('a crypto quote that states no currency gets USD from the reference, with its origin; two requests', async () => {
    const h = harness({ '/quote': { body: quoteBody() }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    const { quote } = await h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING });
    expect(quote.currency).toBe('USD');
    expect(quote.currencyOrigin).toEqual({ kind: 'reference', source: CRYPTO_REFERENCE_SOURCE, stated: 'US Dollar', rule: TWELVE_DATA_CURRENCY_NAMES_VERSION, retrievedAt: '2026-10-19T12:00:00.000Z' });
    expect(h.paths()).toEqual(['/quote', '/cryptocurrencies']);
    expect(h.calls[1]!.searchParams.get('symbol')).toBe('ETH/USD');
  });

  it('the reference is reused within its window and read again after it; the origin keeps the time it was read', async () => {
    const h = harness({ '/quote': { body: quoteBody() }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    await h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING });
    h.advance(60_000);
    const second = await h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING });
    expect(h.paths()).toEqual(['/quote', '/cryptocurrencies', '/quote']);
    expect(second.quote.currencyOrigin).toMatchObject({ retrievedAt: '2026-10-19T12:00:00.000Z' });
    h.advance(CRYPTO_REFERENCE_TTL_MS);
    await h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING });
    expect(h.paths()).toEqual(['/quote', '/cryptocurrencies', '/quote', '/quote', '/cryptocurrencies']);
  });

  it('concurrent quotes share one reference read', async () => {
    const h = harness({ '/quote': { body: quoteBody() }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    await Promise.all([1, 2, 3].map(() => h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING })));
    expect(h.paths().filter((p) => p === '/cryptocurrencies')).toHaveLength(1);
  });

  it('a refused reference read (plan restriction) leaves the quote without currency, is not kept, and the next quote tries again', async () => {
    let refuse = true;
    const h = harness({
      '/quote': { body: quoteBody() },
      '/cryptocurrencies': () => (refuse ? { status: 403, body: { status: 'error', code: 403, message: 'not available on your plan' } } : { body: LIVE_RESPONSE }),
    });
    const first = await h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING });
    expect(first.quote.currency).toBeUndefined();
    expect(first.quote.currencyOrigin).toEqual({ kind: 'unresolved', reason: 'REFERENCE_UNAVAILABLE' });
    refuse = false;
    const second = await h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING });
    expect(second.quote.currency).toBe('USD');
  });

  it('a reference without the pair, or with an unknown name, gives no currency', async () => {
    const none = harness({ '/quote': { body: quoteBody() }, '/cryptocurrencies': { body: { status: 'ok', data: [] } } });
    expect((await none.p.getQuote({ instrument: ETH_USD, mapping: MAPPING })).quote).toMatchObject({ currencyOrigin: { kind: 'unresolved', reason: 'NO_REFERENCE' } });
    expect((await none.p.getQuote({ instrument: ETH_USD, mapping: MAPPING })).quote.currency).toBeUndefined();
    const unknown = harness({ '/quote': { body: quoteBody() }, '/cryptocurrencies': { body: { status: 'ok', data: [{ symbol: 'ETH/USD', currency_base: 'Ethereum', currency_quote: 'Dollar', available_exchanges: ['Binance'] }] } } });
    const q = (await unknown.p.getQuote({ instrument: ETH_USD, mapping: MAPPING })).quote;
    expect(q.currency).toBeUndefined();
    expect(q.currencyOrigin).toEqual({ kind: 'unresolved', reason: 'UNKNOWN_CURRENCY_NAME' });
  });

  it('a stated quote currency is never replaced by the reference, even a different one', async () => {
    const h = harness({ '/quote': { body: quoteBody({ currency: 'EUR' }) }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    const { quote } = await h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING });
    expect(quote.currency).toBe('EUR');
    expect(quote.currencyOrigin).toEqual({ kind: 'stated', field: 'currency' });
    expect(h.paths()).toEqual(['/quote']);
  });

  it('a stated currency that is not an ISO code is not translated and not filled from the reference', async () => {
    const h = harness({ '/quote': { body: quoteBody({ currency_quote: 'US Dollar' }) }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    const { quote } = await h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING });
    expect(quote.currency).toBeUndefined();
    expect(quote.currencyOrigin).toEqual({ kind: 'unresolved', reason: 'STATED_CURRENCY_NOT_ISO' });
    expect(h.paths()).toEqual(['/quote']);
  });

  it('a reference currency that contradicts the registered instrument currency is a schema error', async () => {
    const h = harness({ '/quote': { body: quoteBody() }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    const ethEur: Instrument = { ...ETH_USD, currency: 'EUR' };
    await expect(h.p.getQuote({ instrument: ethEur, mapping: MAPPING })).rejects.toMatchObject({ code: 'schema_invalid' });
  });

  it('a mapping venue the pair is not listed on gives no currency', async () => {
    const h = harness({ '/quote': { body: quoteBody() }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    const { quote } = await h.p.getQuote({ instrument: ETH_USD, mapping: { ...MAPPING, exchange: 'Coinbase Pro' } });
    expect(quote.currencyOrigin).toEqual({ kind: 'unresolved', reason: 'EXCHANGE_NOT_LISTED' });
    expect(quote.currency).toBeUndefined();
  });

  it('other instruments are unchanged: a stock quote without currency reads no reference', async () => {
    const aapl: Instrument = { instrumentId: 'ins_test_aapl', assetClass: 'stock', symbol: 'AAPL', currency: 'USD', timezone: 'America/New_York', active: true };
    const h = harness({ '/quote': { body: quoteBody({ symbol: 'AAPL', name: 'Apple Inc' }) }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    const { quote } = await h.p.getQuote({ instrument: aapl, mapping: { ...MAPPING, instrumentId: aapl.instrumentId, providerSymbol: 'AAPL' } });
    expect(quote.currency).toBeUndefined();
    expect(quote.currencyOrigin).toBeUndefined();
    expect(h.paths()).toEqual(['/quote']);
  });
});

const SEARCH_ETH = { status: 'ok', data: ['Binance', 'Huobi', 'Bitfinex'].map((exchange) => ({ symbol: 'ETH/USD', instrument_name: 'Ethereum US Dollar', exchange, mic_code: '', exchange_timezone: 'UTC', instrument_type: 'Digital Currency', country: '', currency: '' })) };
const SEARCH_AAPL = { status: 'ok', data: [{ symbol: 'AAPL', instrument_name: 'Apple Inc', exchange: 'NASDAQ', mic_code: 'XNGS', exchange_timezone: 'America/New_York', instrument_type: 'Common Stock', country: 'United States', currency: 'USD' }] };

describe('O22 crypto registration metadata through the provider', () => {
  it('a crypto search row without currency gets it from the reference, with its origin', async () => {
    const h = harness({ '/symbol_search': { body: SEARCH_ETH }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    const c = await h.p.getInstrument('ETH/USD');
    expect(c).toMatchObject({ providerSymbol: 'ETH/USD', assetClass: 'crypto', exchange: 'Binance', currency: 'USD', currencyOrigin: { kind: 'reference', stated: 'US Dollar' } });
    expect(h.paths()).toEqual(['/symbol_search', '/cryptocurrencies']);
  });

  it('an unknown name leaves the candidate without currency, so the registration is refused', async () => {
    const h = harness({ '/symbol_search': { body: SEARCH_ETH }, '/cryptocurrencies': { body: { status: 'ok', data: [{ symbol: 'ETH/USD', currency_base: 'Ethereum', currency_quote: 'Tether', available_exchanges: ['Binance'] }] } } });
    const c = await h.p.getInstrument('ETH/USD');
    expect(c?.currency).toBeUndefined();
    expect(c?.currencyOrigin).toEqual({ kind: 'unresolved', reason: 'UNKNOWN_CURRENCY_NAME' });
  });

  it('a failed reference read fails the registration lookup instead of hiding it', async () => {
    const h = harness({ '/symbol_search': { body: SEARCH_ETH }, '/cryptocurrencies': { status: 403, body: { status: 'error', code: 403, message: 'not available on your plan' } } });
    await expect(h.p.getInstrument('ETH/USD')).rejects.toMatchObject({ code: 'not_entitled' });
  });

  it('other instruments are unchanged: a stock candidate keeps its stated currency and reads no reference', async () => {
    const h = harness({ '/symbol_search': { body: SEARCH_AAPL }, '/cryptocurrencies': { body: LIVE_RESPONSE } });
    const c = await h.p.getInstrument('AAPL');
    expect(c).toMatchObject({ currency: 'USD' });
    expect(c?.currencyOrigin).toBeUndefined();
    expect(h.paths()).toEqual(['/symbol_search']);
  });
});

describe('O22 registration and quote through the runtime services', () => {
  it('registers ETH/USD once with USD, records the origin in the registry event, and the quote reports USD with its origin', async () => {
    const h = harness({ '/symbol_search': { body: SEARCH_ETH }, '/cryptocurrencies': { body: LIVE_RESPONSE }, '/quote': { body: quoteBody() } });
    const log = new InMemoryAppendOnlyStore<InstrumentEvent>();
    const registry = await InstrumentRegistry.open(log);
    const store = new InMemoryMarketDataStore();
    const marketData = new MarketDataService({ registry, store, providers: [h.p], clock: () => new Date(T0) });
    const services = createRuntimeServices({
      registry,
      marketData,
      quant: new QuantService({ registry, store, runs: new InMemoryQuantRunStore() }),
      killSwitch: await PortfolioKillSwitchStore.open(new InMemoryAppendOnlyStore()),
      provider: h.p,
      marketDataMode: 'production',
      ping: async () => true,
      version: 'test',
      clock: () => new Date(T0),
    });
    const request = { providerSymbol: 'ETH/USD', validFrom: '2026-10-19T12:00:00.000Z' };
    const item = await services.registerInstrument(request);
    expect(item).toMatchObject({ assetClass: 'crypto', currency: 'USD', exchange: 'Binance', currencyOrigin: { kind: 'reference', stated: 'US Dollar' } });
    expect(registry.get(item.instrumentId!)).toMatchObject({ assetClass: 'crypto', currency: 'USD', active: true });
    const again = await services.registerInstrument(request);
    expect(again.instrumentId).toBe(item.instrumentId);
    expect(registry.list()).toHaveLength(1);
    const events = await log.loadAll();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ type: 'instrument_registered', reason: expect.stringContaining('currency from ' + CRYPTO_REFERENCE_SOURCE + ' "US Dollar" by rule ' + TWELVE_DATA_CURRENCY_NAMES_VERSION) });

    const quote = (await services.quote(item.instrumentId!)) as Record<string, unknown>;
    expect(quote).toMatchObject({ currency: 'USD', currencyOrigin: { kind: 'reference', stated: 'US Dollar', rule: TWELVE_DATA_CURRENCY_NAMES_VERSION } });
    // One reference read for the registration lookups and the quote together (within the reuse window).
    expect(h.paths().filter((p) => p === '/cryptocurrencies')).toHaveLength(1);
  });
});
