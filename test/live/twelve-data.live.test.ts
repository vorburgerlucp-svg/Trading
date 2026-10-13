// REAL provider smoke test (network). Not part of `npm run check`: `npm run test:live`.
//   * with TWELVE_DATA_API_KEY in the environment: production key (never printed)
//   * with NEXUS_TWELVE_DATA_DEMO=1: Twelve Data's documented public demo key; data is labelled "demo"
//   * otherwise: reported as NOT RUN (skipped with the reason), never as passed
// The report printed below contains provider, instrument, timestamps, response status and the
// normalized result — no secrets.

import { describe, expect, it } from 'vitest';
import { InstrumentRegistry } from '../../src/market-data/instrument-registry.js';
import { MarketDataService } from '../../src/market-data/market-data-service.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import type { Instrument } from '../../src/market-data/market-data-types.js';
import { TwelveDataMarketDataProvider } from '../../src/market-data/providers/twelve-data.js';
import { toUtcIso } from '../../src/market-data/time.js';

const key = process.env.TWELVE_DATA_API_KEY?.trim();
const demo = process.env.NEXUS_TWELVE_DATA_DEMO === '1';
const provider = key ? TwelveDataMarketDataProvider.fromEnv(process.env) : demo ? TwelveDataMarketDataProvider.publicDemo() : null;
const reason = 'no TWELVE_DATA_API_KEY and NEXUS_TWELVE_DATA_DEMO is not 1';
// The demo key only serves provider defaults (split-adjusted); a production key requests raw prices.
const adjustment = key ? ('raw' as const) : ('split_adjusted' as const);

const INSTRUMENT: Instrument = {
  instrumentId: 'ins_live_aapl',
  assetClass: 'stock',
  symbol: 'AAPL',
  currency: 'USD',
  exchange: 'NASDAQ',
  // exact listing segment as the provider reports it; the calendar belongs to the operating venue
  mic: 'XNGS',
  timezone: 'America/New_York',
  tradingCalendar: 'XNAS',
  active: true,
};

describe.skipIf(!provider)('REAL Twelve Data smoke test' + (provider ? '' : ' (NOT RUN: ' + reason + ')'), () => {
  it('AAPL Tagesbars und Quote: echte Antwort, normalisiert, validiert, gespeichert', { timeout: 120_000 }, async () => {
    const human = { kind: 'human' as const, id: 'smoke-test' };
    const registry = await InstrumentRegistry.open();
    await registry.register(INSTRUMENT, { at: '2026-01-01T00:00:00Z', by: human, reason: 'smoke test' });
    await registry.addMapping({ instrumentId: INSTRUMENT.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '1980-12-12T00:00:00Z' }, { at: '2026-01-01T00:00:00Z', by: human, reason: 'smoke test' });
    const store = new InMemoryMarketDataStore();
    const service = new MarketDataService({ registry, store, providers: [provider!] });
    const now = Date.now();
    const from = toUtcIso(now - 14 * 86_400_000);
    const to = toUtcIso(now);
    const backfill = await service.backfillBars({ instrumentId: INSTRUMENT.instrumentId, provider: 'twelvedata', interval: '1d', adjustment, from, to });
    const series = await service.readSeries({ instrumentId: INSTRUMENT.instrumentId, source: backfill.source, interval: '1d', session: 'regular', adjustment, asOf: toUtcIso(Date.now()), finalOnly: false, useCase: 'analysis' });
    let quote: unknown = 'not requested';
    try {
      const q = await service.refreshQuote(INSTRUMENT.instrumentId, 'twelvedata');
      quote = q.quote ? { observedAt: q.quote.observedAt, retrievedAt: q.quote.retrievedAt, last: q.quote.last.toString(), marketOpen: q.quote.marketOpen ?? null } : null;
    } catch (error) {
      quote = { error: (error as { code?: string }).code ?? 'unknown', message: (error as Error).message };
    }
    const first = series.bars[0];
    const last = series.bars[series.bars.length - 1];
    const fmt = (b: typeof first) => (b ? { startTime: b.startTime, endTime: b.endTime, open: b.open.toString(), high: b.high.toString(), low: b.low.toString(), close: b.close.toString(), volume: b.volume?.toString() ?? null, isFinal: b.isFinal, availableAt: b.availableAt, retrievedAt: b.retrievedAt } : null);
    console.log(
      '[live] ' +
        JSON.stringify(
          {
            provider: 'twelvedata',
            environment: provider!.source('time_series').environment,
            instrument: 'AAPL (XNGS → venue XNAS)',
            adjustment,
            interval: '1d',
            requestedRange: { from, to },
            responseStatus: { requests: backfill.requests, bars: series.bars.length, inserted: backfill.windows[0]?.summary.inserted, quarantined: backfill.windows[0]?.summary.quarantined.length },
            firstBar: fmt(first),
            lastBar: fmt(last),
            quality: { valid: series.quality.valid, severity: series.quality.severity, codes: series.quality.issues.map((i) => i.code) },
            quote,
            health: provider!.health(),
          },
          null,
          2,
        ),
    );
    expect(series.bars.length).toBeGreaterThan(0);
    expect(backfill.windows[0]!.summary.quarantined).toEqual([]);
    expect(series.quality.valid).toBe(true);
  });
});
