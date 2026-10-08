import { describe, expect, it } from 'vitest';
import { InstrumentRegistry } from '../../src/market-data/instrument-registry.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { FOREX_24X5, getCalendar } from '../../src/market-data/sessions.js';
import { parseUtc, toUtcIso } from '../../src/market-data/time.js';
import { Decimal } from '../../src/money/decimal.js';
import { canonicalJson } from '../../src/persistence/canonical-json.js';
import { computeQuant, quantResultHash, type QuantInput } from '../../src/quant/quant-engine.js';
import { InMemoryQuantRunStore } from '../../src/quant/quant-run-store.js';
import { QuantService } from '../../src/quant/quant-service.js';
import { AAPL, EURUSD, FIXTURE_SOURCE, dailyBars, intradayBars, randomOhlcv } from '../market-data/fixtures.js';

const XNAS = getCalendar('XNAS')!;
const CREATED = { createdAt: '2026-12-31T00:00:00.000Z' };
const DAILY = { source: FIXTURE_SOURCE.sourceId, interval: '1d' as const, session: 'regular' as const, adjustment: 'raw' as const };
const FIVE = { ...DAILY, interval: '5m' as const };
const HUMAN = { kind: 'human' as const, id: 'luc' };

const scaleBar = (b: MarketBar, k: string): MarketBar => ({ ...b, open: b.open.times(k), high: b.high.times(k), low: b.low.times(k), close: b.close.times(k), ...(b.volume ? { volume: b.volume.times(100) } : {}) });

function input(bars: MarketBar[], asOf: string, extra: Partial<QuantInput> = {}): QuantInput {
  return { instrument: AAPL, calendar: XNAS, series: DAILY, bars, asOf, sourceInfo: FIXTURE_SOURCE, useCase: 'backtest', ...extra };
}

describe('Kein Look-ahead (Pflichttest)', () => {
  it('Tagesbars: alles nach T massiv verändert → Ergebnis für T kanonisch identisch', () => {
    const series = dailyBars(XNAS, '2026-01-05', randomOhlcv(240, 42));
    const t = parseUtc(series[180]!.availableAt) + 60_000;
    const asOf = toUtcIso(t);
    const before = computeQuant(input(series, asOf), CREATED);

    const mutated: MarketBar[] = series.map((b, i) => (i > 180 ? scaleBar(b, '10') : b));
    // a later correction of bar 180 that only became known after T
    mutated.push({ ...scaleBar(series[180]!, '3'), availableAt: toUtcIso(t + 86_400_000), retrievedAt: toUtcIso(t + 86_400_000) });
    // the next session's still-forming bar
    mutated.push({ ...series[181]!, isFinal: false, availableAt: toUtcIso(t + 3_600_000), observedAt: toUtcIso(t + 3_600_000), retrievedAt: toUtcIso(t + 3_600_000) });
    const after = computeQuant(input(mutated, asOf), CREATED);

    expect(canonicalJson(after)).toBe(canonicalJson(before));
    expect(before.barCount).toBe(181);
    expect(before.indicators.sma['50']!.status).toBe('ok');
    expect(before.swings.confirmedCount).toBeGreaterThan(0);
  });

  it('5-Minuten-Bars mitten in der Session: bildender Bar und alles danach ohne Einfluss', () => {
    const bars = intradayBars(XNAS, '2026-10-06T13:30:00Z', '5m', randomOhlcv(78 * 3, 9));
    const asOf = '2026-10-08T15:02:30.000Z'; // Oct 8, 11:02:30 EDT: the 11:00 bar is forming
    const visible = bars.filter((b) => parseUtc(b.availableAt) <= parseUtc(asOf));
    const before = computeQuant(input(visible, asOf, { series: FIVE }), CREATED);
    const after = computeQuant(input(bars.map((b) => (parseUtc(b.availableAt) > parseUtc(asOf) ? scaleBar(b, '7') : b)), asOf, { series: FIVE }), CREATED);
    expect(canonicalJson(after)).toBe(canonicalJson(before));
    expect(before.indicators.vwap).toMatchObject({ status: 'ok', value: { sessionKey: '2026-10-08' } });
  });
});

describe('Determinismus und Fingerprint', () => {
  it('gleicher Input → bitgleiches Ergebnis, gleiche quantRunId; anderer asOf → anderer Fingerprint', () => {
    const a = computeQuant(input(dailyBars(XNAS, '2026-01-05', randomOhlcv(220, 5)), '2026-11-20T00:00:00Z'), CREATED);
    const b = computeQuant(input(dailyBars(XNAS, '2026-01-05', randomOhlcv(220, 5)), '2026-11-20T00:00:00Z'), CREATED); // rebuilt objects
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(b.quantRunId).toBe(a.quantRunId);
    expect(a.quantRunId).toBe('qr_' + a.inputFingerprint.slice(0, 40));
    const c = computeQuant(input(dailyBars(XNAS, '2026-01-05', randomOhlcv(220, 5)), '2026-11-21T00:00:00Z'), CREATED);
    expect(c.inputFingerprint).not.toBe(a.inputFingerprint);
    // createdAt is metadata, not content
    expect(quantResultHash(computeQuant(input(dailyBars(XNAS, '2026-01-05', randomOhlcv(220, 5)), '2026-11-20T00:00:00Z'), { createdAt: '2027-01-01T00:00:00.000Z' }))).toBe(quantResultHash(a));
  });

  it('Algorithmus-Versionen und Parameter sind Teil des Ergebnisses', () => {
    const r = computeQuant(input(dailyBars(XNAS, '2026-01-05', randomOhlcv(60, 5)), '2026-06-01T00:00:00Z'), CREATED);
    expect(r.algorithmVersions).toMatchObject({ rsi: 'rsi:wilder:v1', atr: 'atr:wilder:v1', ema: 'ema:sma-seed:v1', macd: 'macd:ema-sma-seed:v1', adx: 'adx:wilder-sum-seed:v1', bollinger: 'bollinger:sma-population-stddev:v1' });
    const other = computeQuant(input(dailyBars(XNAS, '2026-01-05', randomOhlcv(60, 5)), '2026-06-01T00:00:00Z', { parameters: { rsi: 7 } }), CREATED);
    expect(other.quantRunId).not.toBe(r.quantRunId);
  });
});

describe('Final vs. in-progress, Datenqualität, zu wenig Historie', () => {
  const bars = dailyBars(XNAS, '2026-01-05', randomOhlcv(60, 3));
  const asOf = toUtcIso(parseUtc(bars[59]!.availableAt) + 60_000);
  const forming: MarketBar = { ...dailyBars(XNAS, '2026-01-05', randomOhlcv(61, 3))[60]!, isFinal: false };

  it('Standard: nur finale Bars; in-progress nur explizit (Live-Vorschau) und dann markiert', () => {
    const formingVisible = { ...forming, availableAt: toUtcIso(parseUtc(forming.startTime) + 14 * 3_600_000), observedAt: toUtcIso(parseUtc(forming.startTime) + 14 * 3_600_000), retrievedAt: toUtcIso(parseUtc(forming.startTime) + 14 * 3_600_000) };
    const at = toUtcIso(parseUtc(formingVisible.availableAt) + 1000);
    const finalOnly = computeQuant(input([...bars, formingVisible], at, { useCase: 'analysis' }), CREATED);
    expect(finalOnly).toMatchObject({ mode: 'final_only', barCount: 60 });
    const preview = computeQuant(input([...bars, formingVisible], at, { useCase: 'analysis', includeInProgress: true }), CREATED);
    expect(preview).toMatchObject({ mode: 'include_in_progress', barCount: 61 });
    expect(preview.dataQuality.issues.map((i) => i.code)).toContain('partial_bar');
    expect(preview.dataQuality.usableForBacktest).toBe(false);
    expect(preview.quantRunId).not.toBe(finalOnly.quantRunId);
  });

  it('ungültige Daten: fail closed — keine Kennzahl wird aus ihnen berechnet', () => {
    const broken = bars.map((b, i) => (i === 30 ? { ...b, high: b.low.minus('1') } : b));
    const r = computeQuant(input(broken, asOf), CREATED);
    expect(r.dataQuality).toMatchObject({ valid: false, severity: 'critical' });
    expect(r.indicators.rsi).toMatchObject({ status: 'unavailable' });
    expect(r.indicators.rsi.value).toBeUndefined();
    expect(r.pivots.status).toBe('unavailable');
    expect(r.marketStructure.trend).toBe('unknown');
  });

  it('Tagesbar, die vor Sessionschluss als final "verfügbar" ist: kritisch, fail closed (Regression Look-ahead)', () => {
    // bar 59 claims to be final and available at its START (midnight), i.e. before the day's close
    const early = bars.map((b, i) => (i === 59 ? { ...b, availableAt: b.startTime, observedAt: b.startTime } : b));
    const noon = toUtcIso(parseUtc(bars[59]!.startTime) + 12 * 3_600_000);
    const r = computeQuant(input(early, noon), CREATED);
    expect(r.dataQuality.issues.find((i) => i.code === 'invalid_time')?.message).toMatch(/before its completion/);
    expect(r.dataQuality.valid).toBe(false);
    expect(r.indicators.sma['20']!.status).toBe('unavailable');
  });

  it('zu wenig Historie: insufficient_data statt erfundener Werte, Warm-up dokumentiert', () => {
    const r = computeQuant(input(bars.slice(0, 10), asOf), CREATED);
    expect(r.insufficientData).toBe(true);
    expect(r.indicators.sma['200']).toEqual({ status: 'insufficient_data', requiredBars: 200, availableBars: 10, reason: 'not enough history' });
    expect(r.indicators.rsi.status).toBe('insufficient_data');
    expect(r.indicators.adx.status).toBe('insufficient_data');
    expect(r.warmupStatus.rsi).toEqual({ requiredBars: 15, availableBars: 10, ready: false });
    expect(r.warmupStatus.sma20).toEqual({ requiredBars: 20, availableBars: 10, ready: false });
  });
});

describe('Pivots, VWAP, Struktur', () => {
  const bars = intradayBars(XNAS, '2026-10-07T13:30:00Z', '5m', randomOhlcv(78 + 20, 11)); // all of Oct 7 + first 20 bars of Oct 8
  const asOf = '2026-10-08T15:15:00.000Z';

  it('Pivots aus der vorherigen ABGESCHLOSSENEN Session, nie aus der laufenden', () => {
    const r = computeQuant(input(bars, asOf, { series: FIVE }), CREATED);
    const oct7 = bars.slice(0, 78);
    const high = oct7.reduce((m, b) => (b.high.gt(m) ? b.high : m), oct7[0]!.high);
    const low = oct7.reduce((m, b) => (b.low.lt(m) ? b.low : m), oct7[0]!.low);
    expect(r.pivots.basis).toMatchObject({ periodKey: '2026-10-07', barCount: 78, complete: true });
    expect(r.pivots.basis!.high.eq(high) && r.pivots.basis!.low.eq(low) && r.pivots.basis!.close.eq(oct7[77]!.close)).toBe(true);
    // changing today's (visible) bars changes the indicators, not the pivots
    const changed = computeQuant(input(bars.map((b, i) => (i >= 78 ? scaleBar(b, '2') : b)), asOf, { series: FIVE }), CREATED);
    expect(canonicalJson(changed.pivots)).toBe(canonicalJson(r.pivots));
    expect(changed.indicators.vwap.value!.vwap).not.toBe(r.indicators.vwap.value!.vwap);
  });

  it('Session-VWAP startet mit der neuen Session neu', () => {
    const r = computeQuant(input(bars, asOf, { series: FIVE }), CREATED);
    const today = bars.slice(78).filter((b) => parseUtc(b.availableAt) <= parseUtc(asOf));
    let pv = 0;
    let v = 0;
    for (const b of today) {
      const vol = b.volume!.toNumber();
      pv += ((b.high.toNumber() + b.low.toNumber() + b.close.toNumber()) / 3) * vol;
      v += vol;
    }
    expect(Math.abs(r.indicators.vwap.value!.vwap - pv / v)).toBeLessThan(1e-9 * (pv / v));
  });

  it('VWAP auf Tagesbars und ohne Volumen (Forex) ist unavailable', () => {
    const daily = computeQuant(input(dailyBars(XNAS, '2026-01-05', randomOhlcv(30, 2)), '2026-06-01T00:00:00Z'), CREATED);
    expect(daily.indicators.vwap).toMatchObject({ status: 'unavailable', reason: 'session VWAP needs intraday bars' });
    const fx = intradayBars(FOREX_24X5, '2026-10-05T00:00:00Z', '1h', randomOhlcv(30, 2).map(({ volume: _v, ...r }) => r), { instrument: EURUSD, session: 'continuous' });
    const r = computeQuant({ instrument: EURUSD, calendar: FOREX_24X5, series: { ...FIVE, interval: '1h', session: 'continuous' }, bars: fx, asOf: '2026-10-07T00:00:00Z', useCase: 'backtest' }, CREATED);
    expect(r.indicators.vwap).toMatchObject({ status: 'unavailable', reason: 'volume unavailable in this session' });
  });

  it('Swings tragen ihren Bestätigungszeitpunkt; Struktur und Levels nur aus bestätigten Swings', () => {
    const r = computeQuant(input(dailyBars(XNAS, '2026-01-05', randomOhlcv(200, 17)), '2026-11-01T00:00:00Z'), CREATED);
    for (const s of r.swings.recent) {
      expect(parseUtc(s.confirmedAt)).toBeGreaterThan(parseUtc(s.time));
      expect(parseUtc(s.confirmedAt)).toBeLessThanOrEqual(parseUtc(r.asOf));
    }
    expect(['bullish', 'bearish', 'range', 'unknown']).toContain(r.marketStructure.trend);
    for (const l of r.supportResistance.levels) {
      expect(l.touchCount).toBeGreaterThanOrEqual(2);
      expect(l.strengthScore).toBeGreaterThanOrEqual(0);
      expect(l.strengthScore).toBeLessThanOrEqual(1);
    }
  });
});

describe('QuantService: gleiche Mathematik für Live und Backtest, Replay', () => {
  async function setup() {
    const registry = await InstrumentRegistry.open();
    await registry.register({ ...AAPL }, { at: '2026-01-01T00:00:00Z', by: HUMAN, reason: 'setup' });
    const store = new InMemoryMarketDataStore();
    await store.registerSource(FIXTURE_SOURCE);
    const runs = new InMemoryQuantRunStore();
    return { registry, store, runs, service: new QuantService({ registry, store, runs, clock: () => new Date('2026-12-01T00:00:00Z') }) };
  }

  it('Replay ist identisch, auch nachdem eine Lücke mit alten Zeitstempeln nachgefüllt wurde', async () => {
    const { store, service } = await setup();
    const all = dailyBars(XNAS, '2026-01-05', randomOhlcv(150, 4));
    await store.ingestBars(AAPL, all.filter((_, i) => i !== 50), '2026-11-01T00:00:00Z');
    const run = await service.run({ instrumentId: AAPL.instrumentId, ...DAILY, asOf: '2026-08-01T00:00:00Z', useCase: 'backtest' });
    expect(await service.run({ instrumentId: AAPL.instrumentId, ...DAILY, asOf: '2026-08-01T00:00:00Z', useCase: 'backtest' })).toMatchObject({ status: 'ALREADY_APPLIED' });
    await store.ingestBars(AAPL, [all[50]!], '2026-11-02T00:00:00Z');
    expect((await service.replay(run.record.result.quantRunId)).identical).toBe(true);
  });

  it('Split-adjustiert aus Raw + Corporate Actions, point-in-time', async () => {
    const { store, service } = await setup();
    const raw = dailyBars(XNAS, '2026-06-01', randomOhlcv(120, 8)).map((b) => (b.startTime >= '2026-08-31' ? scaleBar(b, '0.25') : b));
    await store.ingestBars(AAPL, raw, '2026-11-01T00:00:00Z');
    await store.ingestCorporateActions(AAPL, [{ actionKey: 'split:2026-08-31', instrumentId: AAPL.instrumentId, source: FIXTURE_SOURCE.sourceId, type: 'split', exDate: '2026-08-31', ratioFrom: Decimal.from(1), ratioTo: Decimal.from(4), availableAt: '2026-07-30T20:00:00.000Z', retrievedAt: '2026-07-30T20:00:00.000Z' }], '2026-11-01T00:00:00Z');
    const before = await service.run({ instrumentId: AAPL.instrumentId, ...DAILY, adjustment: 'split_adjusted', asOf: '2026-08-21T00:00:00Z', useCase: 'backtest' });
    const rawBefore = await service.run({ instrumentId: AAPL.instrumentId, ...DAILY, asOf: '2026-08-21T00:00:00Z', useCase: 'backtest' });
    // before the ex-date nothing is adjusted: same numbers as raw
    expect(before.record.result.indicators.sma['20']!.value).toBe(rawBefore.record.result.indicators.sma['20']!.value);
    const after = await service.run({ instrumentId: AAPL.instrumentId, ...DAILY, adjustment: 'split_adjusted', asOf: '2026-10-30T00:00:00Z', useCase: 'backtest' });
    const rawAfter = await service.run({ instrumentId: AAPL.instrumentId, ...DAILY, asOf: '2026-10-30T00:00:00Z', useCase: 'backtest' });
    // the adjusted series has no artificial 75 % crash; the raw one does
    expect(after.record.result.indicators.atr.value!).toBeLessThan(rawAfter.record.result.indicators.atr.value!);
    expect((await service.replay(after.record.result.quantRunId)).identical).toBe(true);
  });
});
