import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import { CONTINUOUS_24X7 } from '../../src/market-data/sessions.js';
import { candleGeometry, dojiShapeOf, isBearishEngulfing, isBearishHarami, isBullishEngulfing, isBullishHarami, isDarkCloudCover, isEveningStar, isMorningStar, isPiercingLine, isThreeBlackCrows, isThreeWhiteSoldiers, isTweezerBottom, isTweezerTop } from '../../src/patterns/candles.js';
import { runPatternEngine, type PatternRunInput } from '../../src/patterns/pattern-engine.js';
import { resolvePatternParameters } from '../../src/patterns/pattern-parameters.js';
import { buildChartContext } from '../../src/timeframes/chart-context.js';
import { quantRun } from '../timeframes/fixtures.js';
import { asOfAfter, INSTRUMENT_ID, scaled, SOURCE, XNAS } from './fixtures.js';
import { barsFromRows, barsOnContinuous, background, CANDLE_CASES, FALL, RISE, row, STRICT_MORNING } from './v1c-fixtures.js';

// docs/PATTERN_ENGINE_V1C.md §3–§12, §22. One golden per candle type, exact-decimal boundaries, gap semantics, context, PIT and scale.

const CANDLE_TYPES = new Set(CANDLE_CASES.flatMap((c) => c.expect.map((e) => e.type)));
const D = (s: string) => Decimal.from(s);
const bar = (o: string, h: string, l: string, c: string) => ({ open: D(o), high: D(h), low: D(l), close: D(c) });
const P = resolvePatternParameters().candlestick;

const stock = { instrumentId: INSTRUMENT_ID, assetClass: 'stock' as const, allowsNegativePrices: false };
function input(bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}): PatternRunInput {
  return { instrument: stock, calendar: XNAS, series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, replay: 'decision_time', ...extra };
}
const run = (bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}) => runPatternEngine(input(bars, asOf, extra));
const candleObservations = (r: ReturnType<typeof run>) => r.observations.filter((o) => CANDLE_TYPES.has(o.patternType));
/** The contextual names only: the hammer family, whose name depends on the prior context. Other candles in a background are not the subject. */
const CONTEXTUAL = new Set(['hammer', 'hanging_man', 'inverted_hammer', 'shooting_star']);
const contextual = (r: ReturnType<typeof run>) => candleObservations(r).filter((o) => CONTEXTUAL.has(o.patternType));
const strip = (o: { patternObservationId: string; evidenceRefs: unknown; chartContext: unknown }) => ({ ...o, patternObservationId: undefined, evidenceRefs: undefined, chartContext: undefined });

describe('golden: one exact positive per candle type (§5–§9, §22)', () => {
  for (const c of CANDLE_CASES) {
    it(c.name + ': exactly the expected candle observations, with their participating bars', () => {
      const rows = [...(c.background === 'fall' ? FALL() : RISE()), ...c.candles];
      const bars = barsFromRows(rows);
      const r = run(bars, asOfAfter(bars, bars.length - 1));
      expect(r.status).toBe('READY');
      const got = candleObservations(r)
        .map((o) => ({ type: o.patternType, indices: o.candles!.map((k) => k.barIndex) }))
        .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
      const want = [...c.expect].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
      expect(got).toEqual(want);
      const obs = candleObservations(r)[0]!;
      expect(obs.status).toBe('confirmed');
      expect(obs.target).toEqual({ method: 'none', price: null });
      expect(obs.firstSeenAt).toBe(bars[c.expect[0]!.indices[c.expect[0]!.indices.length - 1]!]!.retrievedAt);
    });
  }
});

/** A flat sequence: closes alternate between base and base + 0.5, so the net move is inside the range context and no bar is a doji. */
export function flatBackground(n: number, base: number): ReturnType<typeof row>[] {
  const out: ReturnType<typeof row>[] = [];
  for (let i = 0; i < n; i++) {
    const close = i % 2 === 0 ? base : base + 0.5;
    const open = i === 0 ? base + 0.5 : i % 2 === 0 ? base + 0.5 : base;
    out.push(row(open, Math.max(open, close) + 0.5, Math.min(open, close) - 0.5, close));
  }
  return out;
}

describe('context: the name comes from the shape and the prior context (§5, §6)', () => {
  it('the same hammer geometry after a falling sequence is a hammer, after a rising sequence a hanging man, and after a flat sequence neither', () => {
    const hammer = [row(81.1, 82.5, 76.1, 82.3)];
    const falling = barsFromRows([...FALL(), ...hammer]);
    const rising = barsFromRows([...RISE(), ...hammer]);
    const flat = barsFromRows([...flatBackground(20, 81), ...hammer]);
    expect(contextual(run(falling, asOfAfter(falling, 20))).map((o) => o.patternType)).toEqual(['hammer']);
    expect(contextual(run(rising, asOfAfter(rising, 20))).map((o) => o.patternType)).toEqual(['hanging_man']);
    expect(contextual(run(flat, asOfAfter(flat, 20)))).toEqual([]);
  });

  it('insufficient context (not enough bars before the candle) emits no contextual alias', () => {
    const short = barsFromRows([...background(5, 100, -1), row(81.1, 82.5, 76.1, 82.3), ...flatBackground(9, 96)]);
    expect(contextual(run(short, asOfAfter(short, 14)))).toEqual([]);
  });

  it('the prior context of a candle uses only bars before it: a later bar, once it is usable, cannot change that candle’s name', () => {
    const bars = barsFromRows([...FALL(), row(81.1, 82.5, 76.1, 82.3), row(82, 83, 81, 82.5)]);
    // Bar 21 is a violent rally. Had the context used it, the hammer at 20 would change. Only hammer observations are compared.
    const changed = barsFromRows([...FALL(), row(81.1, 82.5, 76.1, 82.3), row(60, 70, 50, 55)]);
    const atCandle = (r: ReturnType<typeof run>) => candleObservations(r).filter((o) => o.candles!.some((k) => k.barIndex === 20)).map(strip);
    expect(atCandle(run(bars, asOfAfter(bars, 21)))).toEqual(atCandle(run(changed, asOfAfter(changed, 21))));
    expect(atCandle(run(bars, asOfAfter(bars, 21)))[0]).toMatchObject({ patternType: 'hammer' });
  });
});

describe('exact decimal boundaries, inclusive and exclusive as declared (§7–§9, §12, §22)', () => {
  it('candle geometry is exact: an 18-decimal range is not rounded through Number', () => {
    const g = candleGeometry(bar('10.000000000000000001', '10.000000000000000003', '9.999999999999999999', '10.000000000000000002'));
    expect(g.range.toString()).toBe('0.000000000000000004');
    expect(g.body.toString()).toBe('0.000000000000000001');
  });

  it('doji: body equal to maxBodyToRange × range is a doji (inclusive); one unit more is not', () => {
    expect(dojiShapeOf(bar('82', '84', '80', '82.4'), P)).toBe('doji');
    expect(dojiShapeOf(bar('82', '84', '80', '82.41'), P)).toBeNull();
  });

  it('engulfing: the containment is inclusive; a current open one unit above the previous close is not engulfing', () => {
    const prev = bar('90', '90.5', '87.5', '88');
    expect(isBullishEngulfing(prev, bar('88', '91.5', '87', '90'), P)).toBe(true);
    expect(isBullishEngulfing(prev, bar('88.01', '91.5', '87', '90'), P)).toBe(false);
    expect(isBullishEngulfing(prev, bar('88', '91.5', '87', '89.99'), P)).toBe(false);
  });

  it('harami is strictly smaller: an equal body is an engulfing, never a harami', () => {
    const prev = bar('90', '90.5', '83.5', '84');
    const equalBody = bar('84', '91', '83', '90');
    expect(isBullishEngulfing(prev, equalBody, P)).toBe(true);
    expect(isBullishHarami(prev, equalBody, P)).toBe(false);
  });

  it('piercing: penetration of exactly the proportion is accepted (inclusive); just below is not', () => {
    const prev = bar('90', '90.5', '83.5', '84');
    expect(isPiercingLine(prev, bar('82', '87.5', '81.5', '87'), P)).toBe(true);
    expect(isPiercingLine(prev, bar('82', '87.5', '81.5', '86.99'), P)).toBe(false);
  });

  it('morning star: candle 2 body may touch candle 1 close (inclusive); penetration of candle 3 is inclusive', () => {
    const c1 = bar('100', '100.5', '91.5', '92');
    const c2 = bar('91.5', '92', '89', '91.8');
    const scale = D('3');
    expect(isMorningStar(c1, c2, bar('91.8', '97.5', '91.5', '96'), scale, P, 'optional')).toBe(true);
    expect(isMorningStar(c1, c2, bar('91.8', '97.5', '91.5', '95.99'), scale, P, 'optional')).toBe(false);
  });

  it('tweezer: highs equal within the ATR tolerance (inclusive); one unit more is not', () => {
    const c1 = bar('81', '85', '80.5', '84');
    expect(isTweezerTop(c1, bar('84.5', '85.1', '81.5', '83'), D('2'), P)).toBe(true);
    expect(isTweezerTop(c1, bar('84.5', '85.11', '81.5', '83'), D('2'), P)).toBe(false);
  });

  it('soldiers: progression is inclusive; a step below the minimum is not soldiers', () => {
    const c1 = bar('100', '104.5', '99.8', '104');
    const c2 = bar('102', '104.25', '101.75', '104.2');
    const c3 = bar('103', '104.6', '102.9', '104.4');
    expect(isThreeWhiteSoldiers([c1, c2, c3], D('2'), P)).toBe(true);
    const strict = resolvePatternParameters({ candlestick: { soldiersMinProgressionAtr: '0.21' } }).candlestick;
    expect(isThreeWhiteSoldiers([c1, c2, c3], D('2'), strict)).toBe(false);
  });

  it('evening star: candle 3 penetration is inclusive at the proportion; one unit short is not an evening star', () => {
    const c1 = bar('92', '100.5', '91.5', '100');
    const c2 = bar('101', '102', '100.3', '101.5');
    expect(isEveningStar(c1, c2, bar('100.5', '101', '94.5', '96'), D('3'), P, 'optional')).toBe(true);
    expect(isEveningStar(c1, c2, bar('100.5', '101', '94.5', '96.01'), D('3'), P, 'optional')).toBe(false);
  });

  it('three black crows: the progression is inclusive, and a stricter minimum step refuses the crows', () => {
    const c1 = bar('104', '104.2', '99.5', '100');
    const c2 = bar('102', '102.2', '95.8', '96');
    const c3 = bar('98', '98.3', '91.7', '92');
    expect(isThreeBlackCrows([c1, c2, c3], D('2'), P)).toBe(true);
    const strict = resolvePatternParameters({ candlestick: { soldiersMinProgressionAtr: '2.5' } }).candlestick;
    expect(isThreeBlackCrows([c1, c2, c3], D('2'), strict)).toBe(false);
  });

  it('the unit predicates that are mirrors of each other agree on their own colours', () => {
    const up = bar('84', '90.5', '83.5', '90');
    const down = bar('92', '92.5', '86.5', '87');
    expect(isDarkCloudCover(up, down, P)).toBe(true);
    expect(isBearishEngulfing(up, down, P)).toBe(false);
    expect(isBearishHarami(up, down, P)).toBe(false);
    expect(isTweezerBottom(bar('81', '81.5', '77', '78'), bar('77.5', '79.5', '77', '79'), D('2'), P)).toBe(true);
  });
});

describe('gap semantics (§10, §11)', () => {
  it('strict mode on a sessioned equity series emits the morning star whose gaps exist', () => {
    const bars = barsFromRows([...FALL(), ...STRICT_MORNING]);
    const strict = resolvePatternParameters({ candlestick: { gapMode: 'strict' } });
    const r = run(bars, asOfAfter(bars, 22), { parameters: { candlestick: { gapMode: 'strict' } } });
    expect(strict.candlestick.gapMode).toBe('strict');
    expect(candleObservations(r).map((o) => o.patternType)).toEqual(['morning_star']);
    expect(candleObservations(r)[0]!.geometryMetrics).toMatchObject({ gapPolicy: 'SESSION_GAP_REQUIRED', gapSatisfied: 'strict' });
  });

  it('strict mode refuses the morning star whose gaps do not exist, and optional mode still emits it', () => {
    const rows = CANDLE_CASES.find((c) => c.name === 'morning_star')!.candles;
    const bars = barsFromRows([...FALL(), ...rows]);
    expect(candleObservations(run(bars, asOfAfter(bars, 22), { parameters: { candlestick: { gapMode: 'strict' } } }))).toEqual([]);
    expect(candleObservations(run(bars, asOfAfter(bars, 22)))[0]!.patternType).toBe('morning_star');
  });

  it('a 24x7 series never fabricates a gap: strict gap-dependent patterns are not emitted, and the optional form records the unsupported policy', () => {
    const crypto = { ...stock, assetClass: 'crypto' as const };
    const series = { source: SOURCE, interval: '1d' as const, session: 'continuous' as const, adjustment: 'raw' as const };
    const bars = barsOnContinuous([...FALL(), ...STRICT_MORNING]);
    const strictRun = runPatternEngine({ instrument: crypto, calendar: CONTINUOUS_24X7, series, bars, asOf: asOfAfter(bars, 22), replay: 'decision_time', parameters: { candlestick: { gapMode: 'strict' } } });
    expect(strictRun.status).toBe('READY');
    expect(candleObservations(strictRun)).toEqual([]);
    const optionalRun = runPatternEngine({ instrument: crypto, calendar: CONTINUOUS_24X7, series, bars, asOf: asOfAfter(bars, 22), replay: 'decision_time' });
    const [m] = candleObservations(optionalRun);
    expect(m!.patternType).toBe('morning_star');
    expect(m!.geometryMetrics).toMatchObject({ gapPolicy: 'UNSUPPORTED_FOR_SERIES', gapSatisfied: 'optional' });
  });
});

describe('policy metadata and fingerprint (§12, §20)', () => {
  it('the run carries every V1C policy version, and a changed candlestick threshold changes the run identity', () => {
    const bars = barsFromRows([...FALL(), ...CANDLE_CASES.find((c) => c.name === 'hammer')!.candles]);
    const asOf = asOfAfter(bars, 20);
    const r = run(bars, asOf);
    expect(r).toMatchObject({ engineVersion: 'pattern-engine:v1c', candlestickPolicyVersion: 'candlestick-policy:v1', candleGeometryVersion: 'candle-geometry:v1', candleContextVersion: 'candle-context:v1', gapPolicyVersion: 'candlestick-gap-policy:v1', polePolicyVersion: 'pole-policy:v1', flagPennantPolicyVersion: 'flag-pennant:v1' });
    const changed = run(bars, asOf, { parameters: { candlestick: { dojiMaxBodyToRange: '0.2' } } });
    expect(changed.patternRunId).not.toBe(r.patternRunId);
  });

  it('a contextual candle records the prior context that named it', () => {
    const bars = barsFromRows([...FALL(), row(81.1, 82.5, 76.1, 82.3)]);
    const [h] = contextual(run(bars, asOfAfter(bars, 20)));
    expect(h!.candleContext).toMatchObject({ policy: 'candle-context:v1', state: 'falling' });
  });
});

describe('point-in-time and identity (§2, §3, §11, §31)', () => {
  const rows = CANDLE_CASES.find((c) => c.name === 'morning_star')!.candles;
  const bars = barsFromRows([...FALL(), ...rows]);

  it('the star is not emitted before its third candle, and a future candle cannot complete it early', () => {
    expect(candleObservations(run(bars, asOfAfter(bars, 21)))).toEqual([]);
    expect(candleObservations(run(bars, asOfAfter(bars, 22)))).toHaveLength(1);
  });

  it('every bar after asOf can change and the outputs at asOf are identical', () => {
    const changed = bars.map((b, i) => (i > 21 ? { ...b, high: b.high.plus(30), low: b.low.minus(15), close: b.close.minus(12) } : b));
    expect(candleObservations(run(changed, asOfAfter(bars, 21))).map(strip)).toEqual(candleObservations(run(bars, asOfAfter(bars, 21))).map(strip));
  });

  it('an unusable middle bar ends the prefix: no candle beyond it is used', () => {
    const gap = bars.map((b, i) => (i === 15 ? { ...b, isFinal: false } : b));
    expect(candleObservations(run(gap, asOfAfter(gap, 22)))).toEqual([]);
  });

  it('the candle identity is stable as later bars are added (it binds the participating bars, not asOf)', () => {
    const later = barsFromRows([...FALL(), ...rows, row(97, 97.5, 96.5, 97), row(97, 98, 96, 97.5)]);
    const a = candleObservations(run(bars, asOfAfter(bars, 22)))[0]!;
    const b = candleObservations(run(later, asOfAfter(later, 24)))[0]!;
    expect(b.patternInstanceId).toBe(a.patternInstanceId);
    expect(b.patternObservationId).not.toBe(a.patternObservationId);
  });
});

describe('scale and ChartContext (§22, §29, §38)', () => {
  it('OHLC ×10 keeps every candle classification and normalized metrics; prices scale by 10', () => {
    for (const c of CANDLE_CASES.filter((x) => x.name === 'morning_star' || x.name === 'three_white_soldiers' || x.name === 'tweezer_top')) {
      const base = barsFromRows([...(c.background === 'fall' ? FALL() : RISE()), ...c.candles]);
      const big = scaled(base, 10);
      const end = base.length - 1;
      const a = candleObservations(run(base, asOfAfter(base, end)));
      const b = candleObservations(run(big, asOfAfter(big, end)));
      expect(b.map((o) => o.patternType)).toEqual(a.map((o) => o.patternType));
      expect(b.map((o) => o.geometryMetrics.bodyToRange)).toEqual(a.map((o) => o.geometryMetrics.bodyToRange));
      expect(Number(b[0]!.candles![0]!.close)).toBeCloseTo(Number(a[0]!.candles![0]!.close) * 10, 6);
    }
  });

  it('the same bars with a different ChartContext give identical candle classification and metrics', () => {
    const rows = CANDLE_CASES.find((c) => c.name === 'morning_star')!.candles;
    const bars = barsFromRows([...FALL(), ...rows]);
    const asOf = asOfAfter(bars, 22);
    const bullish = buildChartContext({ instrumentId: 'AAPL', asOf, requestedIntervals: ['1d'], runs: [quantRun({ label: 'bull', interval: '1d', trend: 'bullish', asOf })] });
    const bearish = buildChartContext({ instrumentId: 'AAPL', asOf, requestedIntervals: ['1d'], runs: [quantRun({ label: 'bear', interval: '1d', trend: 'bearish', asOf })] });
    const none = candleObservations(run(bars, asOf)).map(strip);
    expect(candleObservations(run(bars, asOf, { chartContext: bullish })).map(strip)).toEqual(none);
    expect(candleObservations(run(bars, asOf, { chartContext: bearish })).map(strip)).toEqual(none);
  });
});
