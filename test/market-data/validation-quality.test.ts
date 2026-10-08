import { describe, expect, it } from 'vitest';
import { validateBar } from '../../src/market-data/bar-validation.js';
import { MarketDataQualityService, type BarSeriesContext } from '../../src/market-data/data-quality.js';
import { assessBarFreshness, assessQuoteFreshness } from '../../src/market-data/freshness.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { CONTINUOUS_24X7, getCalendar } from '../../src/market-data/sessions.js';
import { Decimal } from '../../src/money/decimal.js';
import { AAPL, BTC, FIXTURE_SOURCE, PRODUCTION_LIKE_SOURCE, dailyBars, flat, intradayBars, randomOhlcv } from './fixtures.js';

const XNAS = getCalendar('XNAS')!;
const quality = new MarketDataQualityService();
const codes = (bars: MarketBar[], ctx: Partial<BarSeriesContext> = {}) => quality.assessBars(bars, { ...stockCtx('2026-11-01T00:00:00Z', 'backtest'), ...ctx }).issues.map((i) => i.code);

function stockCtx(asOf: string, useCase: BarSeriesContext['useCase'], interval: BarSeriesContext['interval'] = '5m'): BarSeriesContext {
  return { instrument: AAPL, calendar: XNAS, interval, session: 'regular', adjustment: 'raw', source: FIXTURE_SOURCE.sourceId, asOf, useCase, sourceInfo: FIXTURE_SOURCE };
}

const fiveMin = (n: number) => intradayBars(XNAS, '2026-10-07T13:30:00Z', '5m', randomOhlcv(n, 3));

describe('Bar Integrity: fehlerhafte Bars werden abgewiesen, nie repariert', () => {
  const good = fiveMin(1)[0]!;

  it('jede OHLC-Regel einzeln', () => {
    expect(validateBar(good)).toEqual([]);
    const cases: Array<[Partial<MarketBar>, RegExp]> = [
      [{ high: Decimal.from('1') }, /high < open/],
      [{ low: Decimal.from('100000') }, /low > open/],
      [{ high: good.low, low: good.high }, /high < low|high < open/],
    ];
    for (const [patch, message] of cases) {
      const issues = validateBar({ ...good, ...patch });
      expect(issues.find((i) => i.code === 'invalid_ohlc')?.message).toMatch(message);
      expect(issues.every((i) => i.severity === 'critical')).toBe(true);
    }
  });

  it('NaN, Infinity, Floats, negative Preise und negatives Volumen', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 101.5]) {
      expect(validateBar({ ...good, close: bad as unknown as Decimal }).map((i) => i.code)).toContain('invalid_number');
    }
    expect(validateBar({ ...good, low: Decimal.from('-1') }).map((i) => i.code)).toContain('negative_price');
    expect(validateBar({ ...good, open: Decimal.from('-1'), low: Decimal.from('-2'), close: Decimal.from('-1'), high: Decimal.from('0') }, { allowsNegativePrices: true })).toEqual([]);
    expect(validateBar({ ...good, volume: Decimal.from('-5') }).map((i) => i.code)).toContain('invalid_volume');
  });

  it('Zeitlogik: kein finaler Bar vor seinem Ende, keine Zukunftszeitstempel, gültiges Intervall', () => {
    expect(validateBar({ ...good, availableAt: '2026-10-07T13:32:00.000Z' }).map((i) => i.code)).toContain('invalid_time');
    // 5 minutes of clock skew are tolerated; beyond that a bar "from the future" is corrupt.
    expect(validateBar({ ...good, retrievedAt: '2026-10-07T13:31:00.000Z' })).toEqual([]);
    expect(validateBar({ ...good, retrievedAt: '2026-10-07T13:20:00.000Z' }).map((i) => i.code)).toContain('future_timestamp');
    expect(validateBar({ ...good, endTime: '2026-10-07T13:45:00.000Z' }).map((i) => i.code)).toContain('misaligned_interval');
    expect(validateBar({ ...good, startTime: '2026-10-07 13:30:00' }).map((i) => i.code)).toContain('invalid_time');
  });
});

describe('MarketDataQualityService', () => {
  it('saubere Serie: ok, für Backtest nutzbar; Test-Fixture-Quelle ist nie handelbar', () => {
    const r = quality.assessBars(fiveMin(20), stockCtx('2026-11-01T00:00:00Z', 'backtest'));
    expect(r).toMatchObject({ valid: true, usableForBacktest: true, usableForTrading: false });
    expect(r.issues.map((i) => i.code)).toEqual(['non_production_source']);
  });

  it('Duplikate: identisch = Warnung, widersprüchlich = kritisch', () => {
    const bars = fiveMin(5);
    expect(codes([...bars, bars[2]!])).toContain('duplicate');
    const conflicting = quality.assessBars([...bars, { ...bars[2]!, close: bars[2]!.close.plus('0.01'), high: bars[2]!.high.plus('0.01') }], stockCtx('2026-11-01T00:00:00Z', 'backtest'));
    expect(conflicting.issues.map((i) => i.code)).toContain('conflicting_duplicate');
    expect(conflicting).toMatchObject({ valid: false, severity: 'critical', usableForBacktest: false });
  });

  it('Out-of-order wird erkannt', () => {
    const bars = fiveMin(5);
    expect(codes([bars[0]!, bars[2]!, bars[1]!, bars[3]!])).toContain('out_of_order');
  });

  it('Lücke am Handelstag erkannt, Wochenende und Feiertag sind keine Lücke', () => {
    const bars = fiveMin(10);
    expect(codes([...bars.slice(0, 4), ...bars.slice(6)])).toContain('gap');
    const daily = dailyBars(XNAS, '2026-03-30', randomOhlcv(6, 5)); // Mon Mar 30 … crosses Good Friday Apr 3 and the weekend
    expect(daily.map((b) => b.startTime.slice(0, 10))).toEqual(['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-06', '2026-04-07']);
    expect(codes(daily, { interval: '1d' })).not.toContain('gap');
    expect(codes([daily[0]!, ...daily.slice(2)], { interval: '1d' })).toContain('gap');
  });

  it('Crypto: fehlende Sonntagskerze IST eine Lücke', () => {
    const btc = dailyBars(CONTINUOUS_24X7, '2026-10-02', randomOhlcv(5, 9), { instrument: BTC, session: 'continuous' });
    const ctx: Partial<BarSeriesContext> = { instrument: BTC, calendar: CONTINUOUS_24X7, interval: '1d', session: 'continuous' };
    expect(codes(btc, ctx)).not.toContain('gap');
    expect(codes([btc[0]!, btc[1]!, ...btc.slice(3)], ctx)).toContain('gap'); // 2026-10-04 is a Sunday
  });

  it('Partial Bar, Look-ahead, gemischte Serien', () => {
    const bars = fiveMin(4);
    const forming = { ...bars[3]!, isFinal: false, availableAt: '2026-10-07T13:47:00.000Z', observedAt: '2026-10-07T13:47:00.000Z', retrievedAt: '2026-10-07T13:47:00.000Z' };
    const r = quality.assessBars([...bars.slice(0, 3), forming], stockCtx('2026-10-07T13:48:00Z', 'analysis'));
    expect(r.issues.map((i) => i.code)).toContain('partial_bar');
    expect(r.usableForBacktest).toBe(false);
    expect(codes(bars, { asOf: '2026-10-07T13:40:00Z' })).toContain('not_yet_available');
    const adjusted = intradayBars(XNAS, '2026-10-07T13:50:00Z', '5m', randomOhlcv(1, 4), { adjustment: 'split_adjusted' });
    expect(codes([...bars, ...adjusted])).toContain('mixed_series');
  });

  it('fehlende Bars am Fensterrand und veraltete Daten (kalenderabhängig)', () => {
    const bars = fiveMin(10); // 13:30 … 14:15
    const r = quality.assessBars(bars, { ...stockCtx('2026-10-07T15:00:00Z', 'trading'), sourceInfo: PRODUCTION_LIKE_SOURCE, window: { from: '2026-10-07T13:30:00Z', to: '2026-10-07T15:00:00Z' } });
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['missing_bars', 'stale']));
    expect(r.usableForTrading).toBe(false);
    const ok = quality.assessBars(bars, { ...stockCtx('2026-10-07T14:21:00Z', 'trading'), sourceInfo: PRODUCTION_LIKE_SOURCE });
    expect(ok).toMatchObject({ valid: true, usableForTrading: true });
  });

  it('Daten vor der verifizierten Kalenderabdeckung: Unsicherheit wird gemeldet, nicht verschwiegen', () => {
    const old = dailyBars(XNAS, '2025-12-29', randomOhlcv(4, 2)); // Mon Dec 29 2025 … Fri Jan 2 2026 (Jan 1 holiday)
    const r = quality.assessBars(old, stockCtx('2026-02-01T00:00:00Z', 'backtest', '1d'));
    expect(r.issues.map((i) => i.code)).toContain('calendar_coverage');
    expect(r.valid).toBe(true);
  });

  it('ohne Kalender keine Handelbarkeit', () => {
    const r = quality.assessBars(fiveMin(5), { ...stockCtx('2026-10-07T14:00:00Z', 'trading'), calendar: null, sourceInfo: PRODUCTION_LIKE_SOURCE });
    expect(r.issues.map((i) => i.code)).toContain('calendar_unknown');
    expect(r.usableForTrading).toBe(false);
  });
});

describe('Freshness: abhängig von Asset-Klasse, Intervall, Session und Use Case', () => {
  it('Aktienquote bei offenem Markt: sehr kurz; bei geschlossenem Markt gilt der letzte Schluss', () => {
    const ctx = { assetClass: 'stock' as const, calendar: XNAS, useCase: 'trading' as const };
    expect(assessQuoteFreshness({ observedAt: '2026-10-07T14:00:00Z' }, { ...ctx, asOf: '2026-10-07T14:00:10Z' }).fresh).toBe(true);
    expect(assessQuoteFreshness({ observedAt: '2026-10-07T14:00:00Z' }, { ...ctx, asOf: '2026-10-07T14:00:30Z' }).fresh).toBe(false);
    expect(assessQuoteFreshness({ observedAt: '2026-10-09T19:59:50Z' }, { ...ctx, asOf: '2026-10-11T12:00:00Z' })).toMatchObject({ fresh: true, marketOpen: false }); // Sunday
    expect(assessQuoteFreshness({ observedAt: '2026-10-08T19:59:50Z' }, { ...ctx, asOf: '2026-10-11T12:00:00Z' }).fresh).toBe(false); // Thursday quote on Sunday
  });

  it('Tageskerze vom Freitag ist am Sonntag aktuell (Aktie), BTC-Tageskerze vom Freitag am Sonntag nicht', () => {
    expect(assessBarFreshness('2026-10-09T04:00:00Z', { interval: '1d', calendar: XNAS, asOf: '2026-10-11T12:00:00Z', useCase: 'trading' }).fresh).toBe(true);
    expect(assessBarFreshness('2026-10-09T00:00:00Z', { interval: '1d', calendar: CONTINUOUS_24X7, asOf: '2026-10-11T12:00:00Z', useCase: 'trading' })).toMatchObject({ fresh: false, missingBars: 1 });
  });

  it('Toleranz hängt vom Use Case ab', () => {
    const ctx = { interval: '5m' as const, calendar: XNAS, asOf: '2026-10-07T14:20:00Z' };
    // last bar 14:00; expected latest complete (2 min settle) 14:10 → 2 bars missing
    expect(assessBarFreshness('2026-10-07T14:00:00Z', { ...ctx, useCase: 'trading' })).toMatchObject({ fresh: false, missingBars: 2 });
    expect(assessBarFreshness('2026-10-07T14:00:00Z', { ...ctx, useCase: 'analysis' })).toMatchObject({ fresh: true, missingBars: 2 });
  });

  it('flat helper erzeugt konsistente Bars', () => {
    expect(validateBar(intradayBars(XNAS, '2026-10-07T13:30:00Z', '5m', flat(1))[0]!)).toEqual([]);
  });
});
