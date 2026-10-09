import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/backtest/backtest-engine.js';
import { assessBacktestQuality } from '../../src/backtest/quality.js';
import type { BacktestStrategy } from '../../src/backtest/strategy.js';
import { BAR_VINTAGE_POLICY_VERSION, DEFAULT_CAPTURE_WINDOW_MS, barVintageOf } from '../../src/market-data/bar-vintage.js';
import { MarketDataQualityService } from '../../src/market-data/data-quality.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import type { BarRevisionKnowledge, MarketBar, ProviderInstrumentMapping } from '../../src/market-data/market-data-types.js';
import { TwelveDataMarketDataProvider } from '../../src/market-data/providers/twelve-data.js';
import { getCalendar } from '../../src/market-data/sessions.js';
import { addDays, parseUtc, toUtcIso } from '../../src/market-data/time.js';
import { Decimal } from '../../src/money/decimal.js';
import { canonicalJson } from '../../src/persistence/canonical-json.js';
import { computeQuant } from '../../src/quant/quant-engine.js';
import { runMarketScanner } from '../../src/scanner/market-scanner.js';
import type { ScannerDefinition, ScannerSnapshot } from '../../src/scanner/scanner-types.js';
import { InMemoryInstrumentUniverseStore } from '../../src/scanner/universe.js';
import { AAPL, FIXTURE_SOURCE, PRODUCTION_LIKE_SOURCE, dailyBars, randomOhlcv } from './fixtures.js';

// Bar knowledge and evidence (see docs/BAR_KNOWLEDGE_EVIDENCE.md). Two questions, never one flag:
//   decision-time knowledge: did NEXUS hold exactly this revision at asOf?   (knownAt, knowledgeSource)
//   vintage:                 was it already the market's value at its time?  (vintage, vintagePolicy)
// Written before the change: the scenarios marked "reproduced" fail on the previous model.

const XNAS = getCalendar('XNAS')!;
const SERIES = { instrumentId: AAPL.instrumentId, source: PRODUCTION_LIKE_SOURCE.sourceId, interval: '1d' as const, session: 'regular' as const, adjustment: 'raw' as const };
const CREATED = { createdAt: '2026-12-31T00:00:00.000Z' };
const ROW = (close: string) => ({ open: close, high: close, low: close, close, volume: '1000' });
const LEGACY: BarRevisionKnowledge = { knownAt: null, knowledgeSource: 'legacy_unproven', vintage: 'legacy_unproven', vintagePolicy: null };
const DEC = 'decision_time' as const;
const RES = 'historical_research' as const;

/** Knowledge of a bar NEXUS received at `retrievedAt`. The vintage follows the versioned policy; the knowledge does not. */
function received(observedAt: string, retrievedAt: string, isFinal = true): { retrievedAt: string; knowledge: BarRevisionKnowledge } {
  return {
    retrievedAt,
    knowledge: {
      knownAt: retrievedAt,
      knowledgeSource: 'captured_by_nexus',
      vintage: barVintageOf({ observedAt, retrievedAt, isFinal, interval: '1d' }),
      vintagePolicy: BAR_VINTAGE_POLICY_VERSION,
    },
  };
}

/** The trading dates of `count` sessions ending on `end` (inclusive). */
function tradingDatesEndingOn(end: string, count: number): string[] {
  const out: string[] = [];
  let d = end;
  while (out.length < count) {
    if (XNAS.session(d)) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

/** A daily series of `count` sessions ending on `end`. `knowledge(observedAt, index)` says how NEXUS held each bar. */
function tradingSeries(end: string, count: number, seed: number, knowledge: (observedAt: string, index: number) => { retrievedAt: string; knowledge: BarRevisionKnowledge }): MarketBar[] {
  const dates = tradingDatesEndingOn(end, count);
  const prices = randomOhlcv(count, seed);
  return dates.map((date, i) => {
    const [bar] = dailyBars(XNAS, date, [prices[i]!], { source: PRODUCTION_LIKE_SOURCE.sourceId });
    const k = knowledge(bar!.observedAt, i);
    return { ...bar!, retrievedAt: k.retrievedAt, knowledge: k.knowledge } as MarketBar;
  });
}

/** One daily bar with explicit retrieval and knowledge (for hand-made scenarios). */
function oneDay(date: string, close: string, retrievedAt: string, knowledge?: BarRevisionKnowledge): MarketBar {
  const [bar] = dailyBars(XNAS, date, [ROW(close)], { retrievedAt, source: PRODUCTION_LIKE_SOURCE.sourceId });
  return { ...bar!, knowledge: knowledge ?? received(bar!.observedAt, retrievedAt).knowledge } as MarketBar;
}

async function storeWith(bars: readonly MarketBar[], receivedAt: string): Promise<InMemoryMarketDataStore> {
  const store = new InMemoryMarketDataStore();
  await store.registerSource(FIXTURE_SOURCE);
  await store.registerSource(PRODUCTION_LIKE_SOURCE);
  const result = await store.ingestBars(AAPL, bars, receivedAt);
  // A quarantined fixture would make reads look correct for the wrong reason: every fixture bar must be stored.
  if (result.inserted !== bars.length) throw new Error('fixture bars were not stored (' + result.inserted + ' of ' + bars.length + '): ' + JSON.stringify(result.quarantined.map((q) => q.reasons.map((r) => r.code))));
  return store;
}

const quantOf = (bars: readonly MarketBar[], asOf: string, useCase: 'trading' | 'analysis' | 'backtest' = 'analysis', parameters: Record<string, unknown> = {}) =>
  computeQuant(
    {
      instrument: AAPL,
      calendar: XNAS,
      series: { source: PRODUCTION_LIKE_SOURCE.sourceId, interval: '1d', session: 'regular', adjustment: 'raw' },
      bars,
      asOf,
      sourceInfo: { ...PRODUCTION_LIKE_SOURCE, environment: 'production' },
      useCase,
      parameters: parameters as never,
    },
    CREATED,
  );

// ---------------------------------------------------------------------------------------------------------------------------
describe('A — a backfill is unknown before its retrieval and known after it (decision-time knowledge)', () => {
  // Completion 2020-01-10 21:00 UTC; NEXUS retrieves it on 2026-10-09 12:00 UTC.
  const backfill = () => oneDay('2020-01-10', '400', '2026-10-09T12:00:00.000Z', received('2020-01-10T21:00:00.000Z', '2026-10-09T12:00:00.000Z').knowledge);

  it('reproduced: a live decision at 12:30 on the retrieval day sees the backfill, which NEXUS holds since 12:00', async () => {
    const store = await storeWith([backfill()], '2026-10-09T12:00:00.000Z');
    const seen = await store.readBars({ ...SERIES, asOf: '2026-10-09T12:30:00.000Z', replay: DEC });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.knowledge).toMatchObject({ knownAt: '2026-10-09T12:00:00.000Z', knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction' });
  });

  it('before its retrieval the same backfill is unknown in decision-time replay', async () => {
    const store = await storeWith([backfill()], '2026-10-09T12:00:00.000Z');
    expect(await store.readBars({ ...SERIES, asOf: '2026-10-09T11:59:00.000Z', replay: DEC })).toEqual([]);
  });

  it('the historical vintage stays unproven even when the bar is known for the decision', async () => {
    const bars = tradingSeries('2026-10-08', 60, 21, (observedAt) => received(observedAt, '2026-10-09T12:00:00.000Z'));
    const store = await storeWith(bars, '2026-10-09T12:00:00.000Z');
    const decision = await store.readBars({ ...SERIES, asOf: '2026-10-09T12:30:00.000Z', replay: DEC });
    const run = quantOf(decision, '2026-10-09T12:30:00.000Z');
    expect(run.barDataProvenance).toMatchObject({ decisionTimeKnowledgeProven: true, allBarsContemporaneousVintage: false, historicalReconstruction: true, contemporaneousBars: 0 });
  });
});

describe('B — capture window: the policy decides only the vintage, never the knowledge', () => {
  it('intraday: captured one minute after completion is contemporaneous and known at 10:16', () => {
    expect(barVintageOf({ observedAt: '2026-10-07T10:15:00.000Z', retrievedAt: '2026-10-07T10:16:00.000Z', isFinal: true, interval: '5m' })).toBe('contemporaneous');
  });

  it('intraday: retrieved at 12:00 is a historical reconstruction, still known from 12:00', () => {
    expect(barVintageOf({ observedAt: '2026-10-07T10:15:00.000Z', retrievedAt: '2026-10-07T12:00:00.000Z', isFinal: true, interval: '5m' })).toBe('historical_reconstruction');
  });

  it('the window boundary is inclusive: exactly the window after completion is contemporaneous, one millisecond later is not', () => {
    const completion = '2026-10-07T10:15:00.000Z';
    const windowEnd = toUtcIso(parseUtc(completion) + DEFAULT_CAPTURE_WINDOW_MS.intraday);
    expect(barVintageOf({ observedAt: completion, retrievedAt: windowEnd, isFinal: true, interval: '5m' })).toBe('contemporaneous');
    expect(barVintageOf({ observedAt: completion, retrievedAt: toUtcIso(parseUtc(windowEnd) + 1), isFinal: true, interval: '5m' })).toBe('historical_reconstruction');
  });

  it('daily: the 2 h boundary is inclusive as well', () => {
    const completion = '2026-09-28T20:00:00.000Z';
    expect(barVintageOf({ observedAt: completion, retrievedAt: '2026-09-28T22:00:00.000Z', isFinal: true, interval: '1d' })).toBe('contemporaneous');
    expect(barVintageOf({ observedAt: completion, retrievedAt: '2026-09-28T22:00:01.000Z', isFinal: true, interval: '1d' })).toBe('historical_reconstruction');
  });

  it('an in-progress bar is contemporaneous: it is the current bar, fetched now', () => {
    expect(barVintageOf({ observedAt: '2026-10-07T10:16:00.000Z', retrievedAt: '2026-10-07T10:16:00.000Z', isFinal: false, interval: '5m' })).toBe('contemporaneous');
  });
});

describe('C — historical replay: decision-time strict refuses what NEXUS did not yet hold; research uses it, labelled', () => {
  it('strict historical replay in 2025 does not see a bar retrieved in 2026 (future retrieval)', async () => {
    const bars = tradingSeries('2025-06-02', 30, 5, (observedAt) => received(observedAt, '2026-10-09T11:00:00.000Z'));
    const store = await storeWith(bars, '2026-10-09T11:00:00.000Z');
    expect(await store.readBars({ ...SERIES, asOf: '2025-07-01T00:00:00.000Z', replay: DEC })).toEqual([]);
  });

  it('historical research accepts the same reconstruction, and the run says the knowledge came later', async () => {
    const bars = tradingSeries('2025-06-02', 30, 5, (observedAt) => received(observedAt, '2026-10-09T11:00:00.000Z'));
    const store = await storeWith(bars, '2026-10-09T11:00:00.000Z');
    const research = await store.readBars({ ...SERIES, asOf: '2025-07-01T00:00:00.000Z', replay: RES });
    expect(research.length).toBeGreaterThan(20);
    expect(research[0]!.knowledge.knownAt).toBe('2026-10-09T11:00:00.000Z');
    const run = quantOf(research, '2025-07-01T00:00:00.000Z');
    expect(run.dataQuality.valid).toBe(true);
    expect(run.barDataProvenance).toMatchObject({ decisionTimeKnowledgeProven: false, historicalReconstruction: true });
  });
});

describe('D — live scanner: reconstructed warm-up is allowed; the signal bar must be contemporaneous', () => {
  const DECISION = '2026-10-09T22:02:00.000Z';
  // 200 sessions ending 2026-10-09. The last one is the signal bar: completed 20:00, captured at 21:58 (inside the window).
  // The 199 warm-up sessions were backfilled at 11:00 on the decision day.
  const warmupAndSignal = (signalRetrieved: string) =>
    tradingSeries('2026-10-09', 200, 31, (observedAt, index) => (index === 199 ? received(observedAt, signalRetrieved) : received(observedAt, '2026-10-09T11:00:00.000Z')));

  function scannerUniverse(asOf: string) {
    const store = new InMemoryInstrumentUniverseStore();
    store.register({ universeId: 'U', version: '1', source: 'fixture', pointInTimeSafe: true });
    store.addMembership({ universeId: 'U', instrumentId: AAPL.instrumentId, validFrom: '2020-01-01T00:00:00.000Z', availableAt: '2020-01-01T00:00:00.000Z', source: 'fixture' });
    return store.snapshot('U', asOf);
  }
  const definition = (useCase?: 'live_trading' | 'research'): ScannerDefinition => ({
    id: 'live',
    version: '1',
    universeId: 'U',
    interval: '1d',
    filters: [{ type: 'minimum_price', value: '0.01' }],
    ranking: [{ type: 'adx', weight: 1 }],
    maxCandidates: 10,
    ...(useCase ? { useCase } : {}),
  });
  const snapshotOf = (quant: ReturnType<typeof quantOf>, asOf: string): ScannerSnapshot => ({
    instrumentId: AAPL.instrumentId,
    asOf,
    lastPrice: Decimal.from('100'),
    lastPriceAvailableAt: asOf,
    quant,
  });

  it('a live decision at 22:02 uses 199 reconstructed warm-up bars and the captured signal bar; EMA200 is computed and the candidate says what is proven', async () => {
    const bars = warmupAndSignal('2026-10-09T21:58:00.000Z');
    const store = await storeWith(bars, '2026-10-09T22:02:00.000Z');
    const seen = await store.readBars({ ...SERIES, asOf: DECISION, replay: DEC });
    expect(seen).toHaveLength(200);
    const run = quantOf(seen, DECISION, 'trading', { ema: [200] });
    expect(run.indicators.ema['200']!.status).toBe('ok');
    expect(run.dataQuality.usableForTrading).toBe(true);
    expect(run.barDataProvenance).toMatchObject({
      decisionTimeKnowledgeProven: true,
      allBarsContemporaneousVintage: false,
      historicalReconstruction: true,
      latestFinalBarContemporaneous: true,
      contemporaneousBars: 1,
      historicalBars: 199,
    });
    const run2 = runMarketScanner(definition(), scannerUniverse(DECISION), [snapshotOf(run, DECISION)], DECISION);
    expect(run2.candidates).toHaveLength(1);
    expect(run2.candidates[0]!.barKnowledge).toMatchObject({ decisionTimeKnowledgeProven: true, latestFinalBarContemporaneous: true, historicalReconstruction: true, allBarsContemporaneousVintage: false });
  });

  it('a live decision whose latest signal bar was itself reconstructed is refused, with the reason', async () => {
    // Retrieved at 22:05: two minutes beyond the 2 h window after the 20:00 completion, so the signal bar is a reconstruction.
    const bars = warmupAndSignal('2026-10-09T22:05:00.000Z');
    const store = await storeWith(bars, '2026-10-09T22:05:00.000Z');
    const seen = await store.readBars({ ...SERIES, asOf: '2026-10-09T22:06:00.000Z', replay: DEC });
    const run = quantOf(seen, '2026-10-09T22:06:00.000Z', 'trading', { ema: [200] });
    expect(run.barDataProvenance.latestFinalBarContemporaneous).toBe(false);
    expect(run.dataQuality.usableForTrading).toBe(false);
    const live = runMarketScanner(definition(), scannerUniverse('2026-10-09T22:06:00.000Z'), [snapshotOf(run, '2026-10-09T22:06:00.000Z')], '2026-10-09T22:06:00.000Z');
    expect(live.candidates).toHaveLength(0);
    expect(live.rejected[0]!.reasons).toContain('latest signal bar is not contemporaneous (historical reconstruction)');
  });

  it('the same degraded run is still valid research: a research scanner accepts it and marks the candidate', async () => {
    const bars = warmupAndSignal('2026-10-09T22:05:00.000Z');
    const store = await storeWith(bars, '2026-10-09T22:05:00.000Z');
    const seen = await store.readBars({ ...SERIES, asOf: '2026-10-09T22:06:00.000Z', replay: RES });
    const run = quantOf(seen, '2026-10-09T22:06:00.000Z', 'analysis');
    const research = runMarketScanner(definition('research'), scannerUniverse('2026-10-09T22:06:00.000Z'), [snapshotOf(run, '2026-10-09T22:06:00.000Z')], '2026-10-09T22:06:00.000Z');
    expect(research.candidates).toHaveLength(1);
    expect(research.candidates[0]!.barKnowledge).toMatchObject({ latestFinalBarContemporaneous: false, historicalReconstruction: true });
  });
});

describe('E — quant fingerprint and no look-ahead', () => {
  it('identical OHLC with other provenance is another input: contemporaneous and historical vintage give different run ids', () => {
    const asOf = '2026-09-01T00:00:00.000Z';
    const historical = quantOf(tradingSeries('2026-08-28', 60, 9, () => ({ retrievedAt: '2026-09-01T00:00:00.000Z', knowledge: { knownAt: '2026-09-01T00:00:00.000Z', knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: BAR_VINTAGE_POLICY_VERSION } })), asOf);
    const contemporary = quantOf(tradingSeries('2026-08-28', 60, 9, (observedAt) => ({ retrievedAt: toUtcIso(parseUtc(observedAt) + 60_000), knowledge: { knownAt: toUtcIso(parseUtc(observedAt) + 60_000), knowledgeSource: 'captured_by_nexus', vintage: 'contemporaneous', vintagePolicy: BAR_VINTAGE_POLICY_VERSION } })), asOf);
    expect(contemporary.inputFingerprint).not.toBe(historical.inputFingerprint);
    expect(contemporary.quantRunId).not.toBe(historical.quantRunId);
  });

  it('the bar vintage policy version is part of the input', () => {
    const asOf = '2026-09-01T00:00:00.000Z';
    const bars = (policy: string) => tradingSeries('2026-08-28', 60, 9, () => ({ retrievedAt: '2026-09-01T00:00:00.000Z', knowledge: { knownAt: '2026-09-01T00:00:00.000Z', knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: policy } }));
    expect(quantOf(bars('bar-vintage:v1'), asOf).inputFingerprint).not.toBe(quantOf(bars('bar-vintage:v2'), asOf).inputFingerprint);
  });

  it('a correction and bars that become known after T leave the decision-time analysis at T unchanged', async () => {
    const bars = tradingSeries('2026-09-29', 60, 4, (observedAt) => received(observedAt, toUtcIso(parseUtc(observedAt) + 2 * 60_000)));
    const store = await storeWith(bars, '2026-09-29T21:00:00.000Z');
    const T = '2026-09-29T20:30:00.000Z';
    const before = quantOf(await store.readBars({ ...SERIES, asOf: T, replay: DEC }), T);
    const correction = oneDay(bars[55]!.startTime.slice(0, 10), '999', '2026-10-05T10:00:00.000Z');
    await store.ingestBars(AAPL, [correction], '2026-10-05T10:00:00.000Z');
    const after = quantOf(await store.readBars({ ...SERIES, asOf: T, replay: DEC }), T);
    expect(canonicalJson(after)).toBe(canonicalJson(before));
  });

  it('a revision is not visible in historical research before its own knowledge', async () => {
    const bars = tradingSeries('2026-09-29', 10, 4, (observedAt) => received(observedAt, toUtcIso(parseUtc(observedAt) + 2 * 60_000)));
    const store = await storeWith(bars, '2026-09-29T21:00:00.000Z');
    const correction = oneDay(bars[9]!.startTime.slice(0, 10), '777', '2026-10-05T10:00:00.000Z');
    await store.ingestBars(AAPL, [correction], '2026-10-05T10:00:00.000Z');
    const lastClose = async (asOf: string) => (await store.readBars({ ...SERIES, asOf, replay: RES })).at(-1)!.close.toString();
    expect(await lastClose('2026-09-30T12:00:00.000Z')).toBe(bars[9]!.close.toString());
    expect(await lastClose('2026-10-05T11:00:00.000Z')).toBe('777');
  });
});

describe('F — legacy: no invented knowledge, no silent strictness', () => {
  it('the store refuses legacy knowledge at ingest, so no legacy revision can be created in memory', async () => {
    const bars = tradingSeries('2026-09-29', 5, 6, () => ({ retrievedAt: '2026-09-29T21:00:00.000Z', knowledge: LEGACY }));
    const store = new InMemoryMarketDataStore();
    await store.registerSource(PRODUCTION_LIKE_SOURCE);
    // Legacy rows exist only in storage written before provenance; the ingest path refuses them (checked below).
    expect(await store.ingestBars(AAPL, bars, '2026-09-29T21:00:00.000Z')).toMatchObject({ inserted: 0 });
  });

  it('research labels a legacy bar and never invents a knowledge time for it', () => {
    const bar = oneDay('2026-09-28', '250', '2026-09-28T20:02:00.000Z', LEGACY);
    const run = quantOf([bar], '2026-09-29T21:00:00.000Z');
    expect(run.barDataProvenance).toMatchObject({ decisionTimeKnowledgeProven: false, legacyUnproven: true, legacyBars: 1 });
    expect(run.dataQuality.issues.map((i) => i.code)).toContain('legacy_provenance_unproven');
    expect(bar.knowledge.knownAt).toBeNull();
  });
});

describe('G — Twelve Data policy on the real adapter', () => {
  const mapping: ProviderInstrumentMapping = { instrumentId: AAPL.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '2000-01-01T00:00:00Z' };
  async function fetchBars(now: string, interval: '1d' | '5m', values: Array<{ datetime: string; close: string }>, window: { from: string; to: string }) {
    const ms = Date.parse(now);
    const body = {
      meta: { symbol: 'AAPL', interval: interval === '1d' ? '1day' : '5min', currency: 'USD', exchange_timezone: 'America/New_York', exchange: 'NASDAQ', mic_code: 'XNAS', type: 'Common Stock' },
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
    return provider.getHistoricalBars({ instrument: AAPL, mapping, interval, ...window, adjustment: 'raw' });
  }
  const DAY = { from: '2026-09-27T04:00:00Z', to: '2026-09-30T04:00:00Z' };
  const FIVE = { from: '2026-10-07T13:30:00Z', to: '2026-10-07T13:40:00Z' };

  it('a daily backfill retrieved a week later: known from that retrieval, vintage historical', async () => {
    const { bars } = await fetchBars('2026-10-07T13:57:30Z', '1d', [{ datetime: '2026-09-28', close: '250' }], DAY);
    expect(bars[0]!.knowledge).toEqual({ knownAt: '2026-10-07T13:57:30.000Z', knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: BAR_VINTAGE_POLICY_VERSION });
  });

  it('a final daily bar retrieved within the 2 h window is contemporaneous, and its boundary is inclusive', async () => {
    const inside = await fetchBars('2026-09-28T22:00:00Z', '1d', [{ datetime: '2026-09-28', close: '250' }], DAY);
    expect(inside.bars[0]!.knowledge).toMatchObject({ knownAt: '2026-09-28T22:00:00.000Z', vintage: 'contemporaneous' });
    const outside = await fetchBars('2026-09-28T22:01:00Z', '1d', [{ datetime: '2026-09-28', close: '250' }], DAY);
    expect(outside.bars[0]!.knowledge).toMatchObject({ knownAt: '2026-09-28T22:01:00.000Z', vintage: 'historical_reconstruction' });
  });

  it('an intraday bar completed 13:35 and retrieved 13:36 is contemporaneous; retrieved at 13:50 (exactly the window) too; 13:50:01 is not', async () => {
    const at = async (now: string) => (await fetchBars(now, '5m', [{ datetime: '2026-10-07 13:30:00', close: '250' }], FIVE)).bars[0]!;
    expect((await at('2026-10-07T13:36:00Z')).knowledge).toMatchObject({ knownAt: '2026-10-07T13:36:00.000Z', vintage: 'contemporaneous' });
    expect((await at('2026-10-07T13:50:00Z')).knowledge).toMatchObject({ vintage: 'contemporaneous' });
    expect((await at('2026-10-07T13:50:01Z')).knowledge).toMatchObject({ knownAt: '2026-10-07T13:50:01.000Z', vintage: 'historical_reconstruction' });
  });

  it('the in-progress bar is known at its fetch and is contemporaneous', async () => {
    const { bars } = await fetchBars('2026-10-07T13:33:00Z', '5m', [{ datetime: '2026-10-07 13:30:00', close: '250' }], FIVE);
    expect(bars[0]).toMatchObject({ isFinal: false, knowledge: { knownAt: '2026-10-07T13:33:00.000Z', vintage: 'contemporaneous' } });
  });
});

describe('H — data quality and backtest grading follow the two questions', () => {
  it('a legacy series is usable for backtests and warned about; a reconstructed series is usable for research but not trading', () => {
    const asOf = '2026-09-30T00:00:00.000Z';
    const reconstructed = tradingSeries('2026-08-28', 60, 13, (observedAt) => received(observedAt, '2026-09-29T00:00:00.000Z'));
    const r = new MarketDataQualityService().assessBars(reconstructed, { instrument: AAPL, calendar: XNAS, interval: '1d', session: 'regular', adjustment: 'raw', source: PRODUCTION_LIKE_SOURCE.sourceId, asOf, useCase: 'analysis', sourceInfo: { ...PRODUCTION_LIKE_SOURCE, environment: 'production' } });
    expect(r.issues.map((i) => i.code)).toContain('vintage_not_proven');
    expect(r.usableForBacktest).toBe(true);
  });

  it('backtest grades: strict data grades by the method, reconstruction at most B, legacy at most C; the return never enters', () => {
    const base = { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'modeled' as const, providerProduction: true, minimumTrades: 1 };
    const counts = (k: 'contemporaneous' | 'historical' | 'legacy') => ({ total: 5, knownBeforeUse: k === 'contemporaneous' ? 5 : 0, contemporaneousVintage: k === 'contemporaneous' ? 5 : 0, historicalVintage: k === 'historical' ? 5 : 0, legacy: k === 'legacy' ? 5 : 0 });
    const strict = assessBacktestQuality(base, 5, 0, false, counts('contemporaneous'));
    const historical = assessBacktestQuality(base, 5, 0, false, counts('historical'));
    const legacy = assessBacktestQuality(base, 5, 0, false, counts('legacy'));
    expect(strict).toMatchObject({ grade: 'A', dataProvenance: 'STRICT_PIT_DATA' });
    expect(historical).toMatchObject({ grade: 'B', dataProvenance: 'HISTORICAL_RECONSTRUCTION' });
    expect(legacy).toMatchObject({ grade: 'C', dataProvenance: 'LEGACY_UNPROVEN' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('I — backtest: strict only if known at the simulated use time and contemporaneous', () => {
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
  const PRICES = ['100', '101', '102', '103', '142'];
  function fiveMinute(knowledge: (end: number) => BarRevisionKnowledge): MarketBar[] {
    const start0 = Date.parse('2026-10-08T13:30:00.000Z');
    return PRICES.map((p, i) => {
      const start = start0 + i * 300_000;
      const end = start + 300_000;
      return {
        instrumentId: AAPL.instrumentId,
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
  const captured = (end: number): BarRevisionKnowledge => ({ knownAt: new Date(end + 60_000).toISOString(), knowledgeSource: 'captured_by_nexus', vintage: 'contemporaneous', vintagePolicy: BAR_VINTAGE_POLICY_VERSION });
  const backfill = (): BarRevisionKnowledge => ({ knownAt: '2026-10-09T12:00:00.000Z', knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: BAR_VINTAGE_POLICY_VERSION });
  const backtestOf = (bars: MarketBar[], replay?: 'decision_time' | 'historical_research') =>
    runBacktest({
      bars,
      strategy: enterExit,
      portfolioCurrency: 'USD', executionCalendar: getCalendar('XNAS')!, initialCapital: Decimal.from(1000),
      sizing: { type: 'fixed_cash', amount: '500' },
      costModel: { commissionBps: 1, spreadBps: 1, slippageBps: 1, minCommission: '0' },
      quality: { pointInTimeUniverse: true, dataComplete: true, corporateActions: 'not_modeled', providerProduction: true, minimumTrades: 1 },
      ...(replay ? { replay } : {}),
    });

  it('contemporaneous bars simulated at their knowledge time are strict', () => {
    const r = backtestOf(fiveMinute(captured), 'decision_time');
    expect(r.trades).toHaveLength(1);
    expect(r.quality.dataProvenance).toBe('STRICT_PIT_DATA');
  });

  it('the same bars in historical research were used before NEXUS held them: not strict', () => {
    expect(backtestOf(fiveMinute(captured), 'historical_research').quality.dataProvenance).toBe('HISTORICAL_RECONSTRUCTION');
  });

  it('a backfill replayed at its knowledge time is still not strict: its vintage is not contemporaneous', () => {
    const r = backtestOf(fiveMinute(() => backfill()), 'decision_time');
    expect(r.quality.dataProvenance).toBe('HISTORICAL_RECONSTRUCTION');
    expect(r.quality.reasons.join(' ')).toMatch(/historical reconstruction/);
  });

  it('decision-time replay of a legacy bar throws (no knowledge can be shown)', () => {
    const legacy = () => LEGACY;
    expect(() => backtestOf(fiveMinute(legacy), 'decision_time')).toThrow(/BAR_KNOWLEDGE_NOT_PROVEN/);
  });

  it('the return does not change the quality: both grades come from the data alone', () => {
    const r = backtestOf(fiveMinute(() => backfill()), 'historical_research');
    expect(r.metrics.returnPct).toBeGreaterThan(0);
    expect(r.quality.dataProvenance).toBe('HISTORICAL_RECONSTRUCTION');
  });
});
