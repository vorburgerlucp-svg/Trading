// O22 B8: the currency of a Twelve Data crypto quote (ETH/USD) comes only from the response, as an ISO code: `currency`, else
// `currency_quote`. A currency name is not translated, the symbol is never parsed for a currency, and conflicting stated currencies
// are a schema error. Without a stated code the quote has no currency, and the demo gate refuses it (INSTRUMENT_NOT_USD).
// TEST DOUBLE: scripted HTTP answers shaped after the official documentation; the numbers are synthetic. No network.
import { describe, expect, it } from 'vitest';
import { MarketDataError } from '../../src/market-data/market-data-provider.js';
import type { Instrument, ProviderInstrumentMapping } from '../../src/market-data/market-data-types.js';
import type { FetchLike, ResilienceDeps } from '../../src/market-data/providers/resilience.js';
import { TwelveDataMarketDataProvider } from '../../src/market-data/providers/twelve-data.js';
import { parseUtc } from '../../src/market-data/time.js';
import { evaluateDemoExecutionGate, DEMO_E2E_CYCLE_POLICY } from '../../src/broker/etoro/execution/execution-gate.js';
import { bodyOf, responseWith } from '../financial/http-body-fixtures.js';

const ETH_USD: Instrument = Object.freeze({ instrumentId: 'ins_test_eth_usd', assetClass: 'crypto', symbol: 'ETH/USD', currency: 'USD', timezone: 'UTC', tradingCalendar: '24x7', active: true });
const MAPPING: ProviderInstrumentMapping = { instrumentId: ETH_USD.instrumentId, provider: 'twelvedata', providerSymbol: 'ETH/USD', validFrom: '2000-01-01T00:00:00Z' };
const NOW = '2026-10-18T21:00:00Z';

function provider(body: Record<string, unknown>) {
  const calls: URL[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(new URL(url));
    return responseWith({ status: 200, body: bodyOf(JSON.stringify(body)) });
  };
  const deps: ResilienceDeps = { now: () => parseUtc(NOW), sleep: async () => undefined, random: () => 0.5 };
  return { calls, p: new TwelveDataMarketDataProvider({ apiKey: 'test-key-123', environment: 'production', fetch, clock: () => new Date(NOW), deps }) };
}

function quoteBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { symbol: 'ETH/USD', name: 'Ethereum US Dollar', exchange: 'Coinbase Pro', datetime: '2026-10-18', timestamp: 1792368000, last_quote_at: 1792364400, open: '2350.10', high: '2380.00', low: '2340.00', close: '2364.57', previous_close: '2349.00', is_market_open: true };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

async function quoteOf(body: Record<string, unknown>) {
  return (await provider(body).p.getQuote({ instrument: ETH_USD, mapping: MAPPING })).quote;
}

describe('O22 Twelve Data crypto quote currency', () => {
  it('`currency: USD` is kept', async () => {
    expect((await quoteOf(quoteBody({ currency: 'USD' }))).currency).toBe('USD');
  });

  it('without `currency`, an ISO `currency_quote` is kept', async () => {
    expect((await quoteOf(quoteBody({ currency_quote: 'USD' }))).currency).toBe('USD');
  });

  it('a currency name is not translated: "US Dollar" gives no currency', async () => {
    expect((await quoteOf(quoteBody({ currency_quote: 'US Dollar' }))).currency).toBeUndefined();
  });

  it('no stated currency gives no currency: the symbol "ETH/USD" is never parsed for one', async () => {
    expect((await quoteOf(quoteBody())).currency).toBeUndefined();
  });

  it('two different stated currencies are a schema error', async () => {
    await expect(quoteOf(quoteBody({ currency: 'USD', currency_quote: 'EUR' }))).rejects.toBeInstanceOf(MarketDataError);
    expect((await quoteOf(quoteBody({ currency: 'USD', currency_quote: 'USD' }))).currency).toBe('USD');
  });

  it('a quote for another symbol is refused', async () => {
    await expect(quoteOf(quoteBody({ symbol: 'ETH/EUR', currency: 'EUR' }))).rejects.toBeInstanceOf(MarketDataError);
  });

  it('one request, to /quote for ETH/USD', async () => {
    const h = provider(quoteBody({ currency: 'USD' }));
    await h.p.getQuote({ instrument: ETH_USD, mapping: MAPPING });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.pathname).toBe('/quote');
    expect(h.calls[0]!.searchParams.get('symbol')).toBe('ETH/USD');
  });
});

describe('O22 the demo gate on a crypto quote without a stated currency', () => {
  it('a quote without currency is INSTRUMENT_NOT_USD; with USD the currency check passes', async () => {
    const base = {
      phase: 'create' as const,
      intent: { action: 'open', side: 'buy', amount: '100', units: null, leverage: 1, stopLoss: null, takeProfit: null, triggerRate: null, instrumentId: ETH_USD.instrumentId, etoroInstrumentId: 100001, createdAt: '2026-10-18T20:59:00.000Z', expiresAt: '2026-10-18T21:10:00.000Z' } as never,
      now: '2026-10-18T21:00:00.000Z',
      policy: DEMO_E2E_CYCLE_POLICY,
      buildLocked: true,
      executionEnabled: true,
      killSwitch: { status: 'ARMED' } as never,
      safety: null,
      instrument: ETH_USD,
      mapping: { instrumentId: ETH_USD.instrumentId, provider: 'etoro', providerSymbol: '100001', validFrom: '2026-10-18T00:00:00.000Z' },
      book: { liveIntentCount: 0, grossExposureUsd: { plus: (x: unknown) => x } as never, instrumentHasLiveIntent: false, anyAmbiguous: false, activeDuplicate: false, closeTargetKnown: false, closeTargetAlreadyClosing: false, openSubmissions: 0, closeSubmissions: 0 },
      broker: { connection: 'connected', lastSuccessfulSync: '2026-10-18T20:59:00.000Z' },
      writeSlotAvailable: true,
    };
    const withoutCurrency = await quoteOf(quoteBody());
    const gateQuote = (q: typeof withoutCurrency) => ({ last: q.last, bid: null, ask: null, currency: q.currency ?? null, observedAt: '2026-10-18T20:59:50.000Z', production: true });
    expect(evaluateDemoExecutionGate({ ...base, quote: gateQuote(withoutCurrency) }).checks.quoteCurrency).toBe('fail');
    expect(evaluateDemoExecutionGate({ ...base, quote: gateQuote(withoutCurrency) }).reasons).toContain('INSTRUMENT_NOT_USD');
    const withUsd = await quoteOf(quoteBody({ currency: 'USD' }));
    expect(evaluateDemoExecutionGate({ ...base, quote: gateQuote(withUsd) }).checks.quoteCurrency).toBe('pass');
  });
});
