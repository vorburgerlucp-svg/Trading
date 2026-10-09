import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import { assessBacktestQuality } from '../../src/backtest/quality.js';
import type { BacktestStrategy } from '../../src/backtest/strategy.js';
import { MarketDataQualityService } from '../../src/market-data/data-quality.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import type { BarRevisionKnowledge, MarketBar, ProviderInstrumentMapping } from '../../src/market-data/market-data-types.js';
import { TwelveDataMarketDataProvider } from '../../src/market-data/providers/twelve-data.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { HOUR_MS, parseUtc, toUtcIso } from '../../src/market-data/time.js';
import { Decimal } from '../../src/money/decimal.js';
import { canonicalJson } from '../../src/persistence/canonical-json.js';
import { computeQuant } from '../../src/quant/quant-engine.js';
import { AAPL, FIXTURE_SOURCE, dailyBars, randomOhlcv } from './fixtures.js';

// Market bar provenance (F9): the market's observability of a bar, the proven knowledge of one revision, and historical
// reconstruction are three different claims. See docs/MARKET_BAR_PROVENANCE.md. These tests were written before the change.

const XNAS = getCalendar('XNAS')!;
const SERIES = { instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, interval: '1d' as const, session: 'regular' as const, adjustment: 'raw' as const };
const CREATED = { createdAt: '2026-12-31T00:00:00.000Z' };
const ROW = (close: string) => ({ open: close, high: close, low: close, close, volume: '1000' });
const HISTORICAL: BarRevisionKnowledge = { provenance: 'historical_bar_reconstruction', revisionKnownAt: null };
const LEGACY: BarRevisionKnowledge = { provenance: 'legacy_unproven', revisionKnownAt: null };

/** The final daily bar of `date`, retrieved at `retrievedAt`, carrying the given knowledge. */
function daily(date: string, close: string, retrievedAt: string, knowledge: BarRevisionKnowledge): MarketBar {
  const [bar] = dailyBars(XNAS, date, [ROW(close)], { retrievedAt });
  return { ...bar!, knowledge } as MarketBar;
}
/** Captured live: NEXUS holds exactly this revision from its retrieval. */
const captured = (date: string, close: string, retrievedAt: string) => daily(date, close, retrievedAt, { provenance: 'captured_by_nexus', revisionKnownAt: retrievedAt });
/** A historical backfill: today's value of an old bar. Its vintage is not proven. */
const reconstructed = (date: string, close: string, retrievedAt: string) => daily(date, close, retrievedAt, HISTORICAL);

async function storeWith(bars: readonly MarketBar[], receivedAt: string): Promise<InMemoryMarketDataStore> {
  const store = new InMemoryMarketDataStore();
  await store.registerSource(FIXTURE_SOURCE);
  await store.ingestBars(AAPL, bars, receivedAt);
  return store;
}

/** A production-sourced daily series of `count` bars. Captured: each bar retrieved two minutes after its completion. */
function series(count: number, seed: number, captureLag: 'live' | 'backfill'): MarketBar[] {
  return dailyBars(XNAS, '2026-06-01', randomOhlcv(count, seed)).map((b) => {
    const retrievedAt = captureLag === 'live' ? toUtcIso(parseUtc(b.observedAt) + 2 * 60_000) : b.retrievedAt;
    const knowledge: BarRevisionKnowledge = captureLag === 'live' ? { provenance: 'captured_by_nexus', revisionKnownAt: retrievedAt } : HISTORICAL;
    return { ...b, retrievedAt, knowledge } as MarketBar;
  });
}

const quantOf = (bars: readonly MarketBar[], asOf: string, useCase: 'trading' | 'analysis' | 'backtest' = 'analysis') =>
  computeQuant(
    { instrument: AAPL, calendar: XNAS, series: { source: FIXTURE_SOURCE.sourceId, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, sourceInfo: { ...FIXTURE_SOURCE, environment: 'production' }, useCase },
    CREATED,
  );

// ---------------------------------------------------------------------------------------------------------------------------
describe('A — historical first revision (F9): reconstruction, not strict point in time', () => {
  it('a bar completed in 2020 and first retrieved in 2026 is usable historically, refused by strict replay, and marked in quant quality', async () => {
    const bar = reconstructed('2020-08-27', '400', '2026-10-07T13:57:30.000Z');
    const store = await storeWith([bar], '2026-10-07T13:57:30.000Z');
    const historical = await store.readBars({ ...SERIES, asOf: '2026-10-07T00:00:00.000Z', replay: 'historical_reconstruction' });
    expect(historical).toHaveLength(1);
    expect(historical[0]!.knowledge).toEqual(HISTORICAL);
    await expect(store.readBars({ ...SERIES, asOf: '2026-10-07T00:00:00.000Z', replay: 'strict_point_in_time' })).rejects.toMatchObject({ code: 'BAR_VINTAGE_NOT_PROVEN' });

    const run = quantOf(historical, '2026-10-07T00:00:00.000Z');
    expect(run.barDataProvenance).toMatchObject({ strictPointInTime: false, historicalReconstruction: true, legacyUnproven: false, historicalBars: 1 });
    expect(run.dataQuality.issues.map((i) => i.code)).toContain('vintage_not_proven');
  });
});

describe('B — live capture: strictly known from its own retrieval', () => {
  const bar = () => captured('2026-09-28', '250', '2026-09-28T20:02:00.000Z');

  it('before NEXUS held the revision, neither mode returns it', async () => {
    const store = await storeWith([bar()], '2026-09-28T20:02:00.000Z');
    expect(await store.readBars({ ...SERIES, asOf: '2026-09-28T20:01:00.000Z', replay: 'strict_point_in_time' })).toEqual([]);
    expect(await store.readBars({ ...SERIES, asOf: '2026-09-28T20:01:00.000Z', replay: 'historical_reconstruction' })).toEqual([]);
  });

  it('after the retrieval the strict replay returns it with its knowledge, and the run is strict', async () => {
    const store = await storeWith([bar()], '2026-09-28T20:02:00.000Z');
    const strict = await store.readBars({ ...SERIES, asOf: '2026-09-28T20:03:00.000Z', replay: 'strict_point_in_time' });
    expect(strict).toHaveLength(1);
    expect(strict[0]!.knowledge).toEqual({ provenance: 'captured_by_nexus', revisionKnownAt: '2026-09-28T20:02:00.000Z' });
    expect(quantOf(strict, '2026-09-28T20:03:00.000Z').barDataProvenance).toMatchObject({ strictPointInTime: true, historicalReconstruction: false, legacyUnproven: false });
  });
});

describe('C — later correction: revision 2 is never visible before its own knowledge', () => {
  it('a captured correction is invisible before its retrieval, in both modes', async () => {
    const rev1 = captured('2026-09-29', '250', '2026-09-29T20:02:00.000Z');
    const rev2 = captured('2026-09-29', '251', '2026-10-01T10:00:00.000Z');
    const store = await storeWith([rev1], '2026-09-29T20:02:00.000Z');
    await store.ingestBars(AAPL, [rev2], '2026-10-01T10:00:00.000Z');
    const close = async (asOf: string, replay: 'strict_point_in_time' | 'historical_reconstruction') => (await store.readBars({ ...SERIES, asOf, replay })).map((b) => b.close.toString());
    expect(await close('2026-09-29T21:00:00.000Z', 'strict_point_in_time')).toEqual(['250']);
    expect(await close('2026-09-29T21:00:00.000Z', 'historical_reconstruction')).toEqual(['250']);
    expect(await close('2026-09-30T12:00:00.000Z', 'historical_reconstruction')).toEqual(['250']);
    expect(await close('2026-10-01T11:00:00.000Z', 'strict_point_in_time')).toEqual(['251']);
  });

  it('a reconstructed first revision followed by a live correction: strict replay refuses the unproven revision', async () => {
    const rev1 = reconstructed('2026-09-29', '250', '2026-10-07T13:57:30.000Z');
    const rev2 = captured('2026-09-29', '251', '2026-10-08T09:00:00.000Z');
    const store = await storeWith([rev1], '2026-10-07T13:57:30.000Z');
    expect((await store.readBars({ ...SERIES, asOf: '2026-10-07T12:00:00.000Z', replay: 'historical_reconstruction' })).map((b) => b.close.toString())).toEqual(['250']);
    await expect(store.readBars({ ...SERIES, asOf: '2026-10-07T12:00:00.000Z', replay: 'strict_point_in_time' })).rejects.toMatchObject({ code: 'BAR_VINTAGE_NOT_PROVEN' });
    await store.ingestBars(AAPL, [rev2], '2026-10-08T09:00:00.000Z');
    expect((await store.readBars({ ...SERIES, asOf: '2026-10-08T12:00:00.000Z', replay: 'strict_point_in_time' })).map((b) => b.close.toString())).toEqual(['251']);
  });
});

describe('D — a historical value retrieved today is not proven to be the value of its day', () => {
  it('a fresh reconstructed series is not usable for trading; the same series captured live is', () => {
    const reconstructedBars = series(60, 11, 'backfill');
    const capturedBars = series(60, 11, 'live');
    const asOf = toUtcIso(parseUtc(reconstructedBars.at(-1)!.observedAt) + HOUR_MS);
    const reconstructedRun = quantOf(reconstructedBars, asOf, 'trading');
    expect(reconstructedRun.dataQuality.issues.map((i) => i.code)).toContain('vintage_not_proven');
    expect(reconstructedRun.dataQuality.usableForTrading).toBe(false);
    expect(reconstructedRun.dataQuality.usableForBacktest).toBe(true);
    const capturedRun = quantOf(capturedBars, asOf, 'trading');
    expect(capturedRun.dataQuality.usableForTrading).toBe(true);
    expect(capturedRun.barDataProvenance.strictPointInTime).toBe(true);
  });
});

describe('E — legacy: nothing is invented, and ingest refuses the legacy label', () => {
  it('a record claiming legacy_unproven is quarantined, not stored', async () => {
    const store = new InMemoryMarketDataStore();
    await store.registerSource(FIXTURE_SOURCE);
    const result = await store.ingestBars(AAPL, [daily('2020-08-27', '400', '2026-10-07T13:57:30.000Z', LEGACY)], '2026-10-07T13:57:30.000Z');
    expect(result).toMatchObject({ inserted: 0 });
    expect(result.quarantined.map((q) => q.reasons[0]!.code)).toEqual(['invalid_time']);
  });
});

describe('H — quant fingerprint: identical OHLC, different provenance, different run', () => {
  it('historical reconstruction and live capture of the same bars produce different inputs and run ids', () => {
    const historical = quantOf(series(60, 5, 'backfill'), '2026-09-01T00:00:00.000Z');
    const live = quantOf(series(60, 5, 'live'), '2026-09-01T00:00:00.000Z');
    expect(live.inputFingerprint).not.toBe(historical.inputFingerprint);
    expect(live.quantRunId).not.toBe(historical.quantRunId);
  });
});

describe('I — no look-ahead through revisions', () => {
  it('corrections and bars that become known after T leave the analysis at T unchanged', async () => {
    const bars = series(60, 9, 'live');
    const store = await storeWith(bars, '2026-09-01T00:00:00.000Z');
    const T = toUtcIso(parseUtc(bars[50]!.observedAt) + 3 * 60_000);
    const before = quantOf(await store.readBars({ ...SERIES, asOf: T, replay: 'strict_point_in_time' }), T);

    const laterCorrection = captured(bars[49]!.startTime.slice(0, 10), '999', toUtcIso(parseUtc(T) + 24 * HOUR_MS));
    const laterBar = captured(bars[52]!.startTime.slice(0, 10), '888', toUtcIso(parseUtc(T) + 48 * HOUR_MS));
    await store.ingestBars(AAPL, [laterCorrection, laterBar], toUtcIso(parseUtc(T) + 48 * HOUR_MS));

    const after = quantOf(await store.readBars({ ...SERIES, asOf: T, replay: 'strict_point_in_time' }), T);
    expect(canonicalJson(after)).toBe(canonicalJson(before));
  });
});

describe('Twelve Data policy: captured versus historical reconstruction', () => {
  const mapping: ProviderInstrumentMapping = { instrumentId: AAPL.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '2000-01-01T00:00:00Z' };
  async function fetchDaily(now: string, values: Array<{ datetime: string; close: string }>) {
    const ms = Date.parse(now);
    const body = {
      meta: { symbol: 'AAPL', interval: '1day', currency: 'USD', exchange_timezone: 'America/New_York', exchange: 'NASDAQ', mic_code: 'XNAS', type: 'Common Stock' },
      values: values.map((v) => ({ datetime: v.datetime, open: v.close, high: v.close, low: v.close, close: v.close, volume: '1000' })),
    };
    const provider = new TwelveDataMarketDataProvider({
      apiKey: 'test-key-123',
      environment: 'production',
      fetch: async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }),
      clock: () => new Date(ms),
      deps: { now: () => ms, sleep: async () => undefined, random: () => 0.5 },
      resilience: { timeoutMs: 50 },
    });
    return provider.getHistoricalBars({ instrument: AAPL, mapping, interval: '1d', from: '2026-09-27T04:00:00Z', to: '2026-09-30T04:00:00Z', adjustment: 'raw' });
  }

  it('a final daily bar fetched within the capture window is captured, known from its retrieval', async () => {
    const { bars } = await fetchDaily('2026-09-28T20:20:00Z', [{ datetime: '2026-09-28', close: '250' }]);
    expect(bars[0]).toMatchObject({ isFinal: true, knowledge: { provenance: 'captured_by_nexus', revisionKnownAt: '2026-09-28T20:20:00.000Z' } });
  });

  it('a final daily bar fetched a week later is a historical reconstruction, never a capture', async () => {
    const { bars } = await fetchDaily('2026-10-07T13:57:30Z', [{ datetime: '2026-09-28', close: '250' }]);
    expect(bars[0]).toMatchObject({ isFinal: true, knowledge: { provenance: 'historical_bar_reconstruction', revisionKnownAt: null } });
  });

  it('the in-progress bar is captured at the moment NEXUS fetched it', async () => {
    const { bars } = await fetchDaily('2026-09-28T18:00:00Z', [{ datetime: '2026-09-28', close: '250' }]);
    expect(bars[0]).toMatchObject({ isFinal: false, knowledge: { provenance: 'captured_by_nexus', revisionKnownAt: '2026-09-28T18:00:00.000Z' } });
  });
});

describe('Data quality: legacy and reconstruction warnings', () => {
  it('legacy bars are usable for backtests but carry their own warning', () => {
    const bars = series(60, 13, 'live').map((b) => ({ ...b, knowledge: LEGACY }) as MarketBar);
    const asOf = toUtcIso(parseUtc(bars.at(-1)!.observedAt) + HOUR_MS);
    const quality = new MarketDataQualityService().assessBars(bars, {
      instrument: AAPL,
      calendar: XNAS,
      interval: '1d',
      session: 'regular',
      adjustment: 'raw',
      source: FIXTURE_SOURCE.sourceId,
      asOf,
      useCase: 'analysis',
      sourceInfo: { ...FIXTURE_SOURCE, environment: 'production' },
    });
    expect(quality.issues.map((i) => i.code)).toContain('legacy_provenance_unproven');
    expect(quality.usableForBacktest).toBe(true);
    expect(quality.usableForTrading).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Backtest quality: the grade reflects the provenance of the bars, never the return
// ---------------------------------------------------------------------------------------------------------------------------

const enterExit: BacktestStrategy = {
  id: 'enter-exit',
  version: '1',
  definition: {},
  warmup: { requiredBars: 1, preferredBars: 1, algorithmVersion: 'test-warmup:v1' },
  evaluate(ctx) {
    if (!ctx.position && ctx.history.length === 1) return { action: 'ENTER_LONG', reasons: ['entry'] };
    if (ctx.position && ctx.history.length === 3) return { action: 'EXIT_LONG', reasons: ['exit'] };
    return { action: 'NONE', reasons: [] };
  },
};

/** Five-minute bars. Captured bars are known one minute after their end; reconstructed bars are historical. */
function fiveMinute(knowledge: (end: number) => BarRevisionKnowledge, prices: string[]): MarketBar[] {
  const start0 = Date.parse('2026-10-08T13:30:00.000Z');
  return prices.map((p, i) => {
    const start = start0 + i * 300_000;
    const end = start + 300_000;
    return {
      instrumentId: 'TEST',
      interval: '5m',
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      open: Decimal.from(p),
      high: Decimal.from(p),
      low: Decimal.from(p),
      close: Decimal.from(p),
      volume: Decimal.from(1000),
      source: 'fixture:production',
      session: 'regular',
      adjustment: 'raw',
      isFinal: true,
      observedAt: new Date(end).toISOString(),
      availableAt: new Date(end).toISOString(),
      retrievedAt: new Date(end + 60_000).toISOString(),
      knowledge: knowledge(end),
    } as MarketBar;
  });
}

const PRICES = ['100', '101', '102', '103', '142'];
const backtestOf = (bars: MarketBar[]) =>
  runBacktest({
    bars,
    strategy: enterExit,
    initialCapital: Decimal.from(1000),
    sizing: { type: 'fixed_cash', amount: '500' },
    costModel: { commissionBps: 1, spreadBps: 1, slippageBps: 1, minCommission: '0' },
    quality: { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled', providerProduction: true, minimumTrades: 1 },
  });

describe('BacktestQuality: provenance is recorded per run and caps the grade; the return never does', () => {
  it('bars captured live are strict point in time: no provenance reason is given', () => {
    const result = backtestOf(fiveMinute((end) => ({ provenance: 'captured_by_nexus', revisionKnownAt: new Date(end + 60_000).toISOString() }), PRICES));
    expect(result.trades).toHaveLength(1);
    expect(result.quality.dataProvenance).toBe('STRICT_PIT_DATA');
    expect(result.quality.reasons.join(' ')).not.toMatch(/historical reconstruction|without provenance/);
  });

  it('historical reconstruction with a large return is labelled, and the reason says the vintage is not proven', () => {
    const result = backtestOf(fiveMinute(() => HISTORICAL, PRICES));
    expect(result.metrics.returnPct).toBeGreaterThan(0);
    expect(result.quality.dataProvenance).toBe('HISTORICAL_RECONSTRUCTION');
    expect(result.quality.reasons.join(' ')).toMatch(/historical reconstruction/);
  });

  it('legacy bars are labelled LEGACY_UNPROVEN', () => {
    const result = backtestOf(fiveMinute(() => LEGACY, PRICES));
    expect(result.quality.dataProvenance).toBe('LEGACY_UNPROVEN');
    expect(result.quality.reasons.join(' ')).toMatch(/without provenance/);
  });

  it('the grade follows the provenance, with corporate actions modeled so that provenance is the only cap under test', () => {
    const base = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'modeled' as const, providerProduction: true, minimumTrades: 1 };
    const strict = assessBacktestQuality(base, 5, 0, false, { total: 5, proven: 5, historical: 0, legacy: 0 });
    const historical = assessBacktestQuality(base, 5, 0, false, { total: 5, proven: 0, historical: 5, legacy: 0 });
    const legacy = assessBacktestQuality(base, 5, 0, false, { total: 5, proven: 0, historical: 0, legacy: 5 });
    expect(strict).toMatchObject({ grade: 'A', dataProvenance: 'STRICT_PIT_DATA' });
    expect(historical).toMatchObject({ grade: 'B', dataProvenance: 'HISTORICAL_RECONSTRUCTION' });
    expect(legacy).toMatchObject({ grade: 'C', dataProvenance: 'LEGACY_UNPROVEN' });
  });

  it('the same OHLC with different provenance has a different backtest run id', () => {
    const live = backtestOf(fiveMinute((end) => ({ provenance: 'captured_by_nexus', revisionKnownAt: new Date(end + 60_000).toISOString() }), PRICES));
    const historical = backtestOf(fiveMinute(() => HISTORICAL, PRICES));
    expect(live.backtestRunId).not.toBe(historical.backtestRunId);
  });
});
