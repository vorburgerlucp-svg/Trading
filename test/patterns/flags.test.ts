import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import { poleChecks } from '../../src/patterns/flags.js';
import { runPatternEngine, type PatternRunInput } from '../../src/patterns/pattern-engine.js';
import { resolvePatternParameters, type PatternParameterOverrides } from '../../src/patterns/pattern-parameters.js';
import { buildChartContext } from '../../src/timeframes/chart-context.js';
import { quantRun } from '../timeframes/fixtures.js';
import { asOfAfter, barsOf, INSTRUMENT_ID, mirroredPivots, scaled, SOURCE, XNAS } from './fixtures.js';
import { barsFromRows, row } from './v1c-fixtures.js';

// docs/PATTERN_ENGINE_V1C.md §14–§18, §22. Flags and pennants need a valid pole first; the pole ends before the consolidation; the breakout does not
// define its own pole. Geometry is in ATR units. Swing prices are the bar extremes (a high pivot at p has high p + 0.5, a low pivot has low p − 0.5).

const FLAG_TYPES = new Set(['bull_flag', 'bear_flag', 'bull_pennant', 'bear_pennant']);

/** Bull flag: pole low 94.5 (bar 4) to high 130.5 (bar 22), a 36-point pole of 18 bars; consolidation lows 121.5, 120.0, 118.5 and highs 127.5, 126.0 on lines of slope −0.25; breakout close 126.2 at bar 41 (confirmed; the consolidation is known at bar 40). */
const BULL_FLAG = [
  [0, 105],
  [4, 95],
  [22, 130],
  [25, 122],
  [28, 127],
  [31, 120.5],
  [34, 125.5],
  [37, 119],
  [42, 128],
  [46, 140],
] as Array<[number, number]>;

/** Bull pennant: the same pole, converging consolidation (upper slope −1/6, lower +1/6), breakout close 127.2 at bar 42. */
const BULL_PENNANT = [
  [0, 105],
  [4, 95],
  [22, 130],
  [25, 122],
  [28, 127],
  [31, 122.5],
  [34, 126],
  [37, 123],
  [41, 124],
  [46, 140],
] as Array<[number, number]>;

const instrument = { instrumentId: INSTRUMENT_ID, assetClass: 'stock' as const, allowsNegativePrices: false };
function input(bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}): PatternRunInput {
  return { instrument, calendar: XNAS, series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, replay: 'decision_time', ...extra };
}
const run = (bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}) => runPatternEngine(input(bars, asOf, extra));
const flags = (r: ReturnType<typeof run>) => r.observations.filter((o) => FLAG_TYPES.has(o.patternType));
const ofType = (r: ReturnType<typeof run>, type: string) => r.observations.filter((o) => o.patternType === type);
const strip = (o: { patternObservationId: string; evidenceRefs: unknown; chartContext: unknown }) => ({ ...o, patternObservationId: undefined, evidenceRefs: undefined, chartContext: undefined });

describe('bull flag golden (§14–§16, §21, §36)', () => {
  const bars = barsOf(BULL_FLAG, 60);

  it('forming before the breakout: pole and consolidation known at bar 40, neutral, first seen at the last consolidation swing', () => {
    const [f] = ofType(run(bars, asOfAfter(bars, 40)), 'bull_flag');
    expect(f).toMatchObject({ status: 'forming', direction: 'neutral', confirmedAt: null });
    expect(f!.firstSeenAt).toBe(bars[40]!.retrievedAt);
    expect(f!.anchors.map((a) => a.role)).toEqual(['pole_start', 'pole_end', 'lower_touch_1', 'upper_touch_1', 'lower_touch_2', 'upper_touch_2', 'lower_touch_3']);
    expect(Number(f!.anchors[0]!.price)).toBe(94.5);
    expect(Number(f!.anchors[1]!.price)).toBe(130.5);
    expect(f!.geometryMetrics).toMatchObject({ poleBars: '18', flagBars: '15', upperTouches: '2', lowerTouches: '3' });
  });

  it('a close above the upper line plus the buffer confirms the continuation at bar 41, bullish', () => {
    const [f] = ofType(run(bars, asOfAfter(bars, 41)), 'bull_flag');
    expect(f).toMatchObject({ status: 'confirmed', direction: 'bullish', confirmation: { direction: 'up' } });
    expect(f!.confirmedAt).toBe(bars[41]!.retrievedAt);
  });

  it('the pole-length target is projected from the breakout (upper line 124.25 + 36 = 160.25) and is active while price has not reached it', () => {
    const [f] = ofType(run(bars, asOfAfter(bars, 46)), 'bull_flag');
    expect(f).toMatchObject({ status: 'target_active', target: { method: 'pole_length_projected_from_breakout' } });
    expect(Number(f!.target.price)).toBeCloseTo(160.25, 2);
  });

  it('the identity is stable from forming through the breakout and the target', () => {
    const ids = [40, 41, 46].map((i) => ofType(run(bars, asOfAfter(bars, i)), 'bull_flag')[0]!.patternInstanceId);
    expect(new Set(ids).size).toBe(1);
  });

  it('the flag lineage names the pole, the consolidation is always after the pole end', () => {
    const [f] = ofType(run(bars, asOfAfter(bars, 41)), 'bull_flag');
    expect(f!.patternLineage).toMatchObject({ parentPatternInstanceId: null, relationship: 'root', rootPatternInstanceId: f!.patternInstanceId });
    const poleEnd = f!.anchors.find((a) => a.role === 'pole_end')!;
    for (const a of f!.anchors.filter((x) => x.role.endsWith('_touch_1') || x.role.includes('_touch_'))) expect(a.barIndex).toBeGreaterThan(poleEnd.barIndex);
  });

  it('invalidated: a final close below the lower line minus the buffer before any breakout invalidates the flag (close-based, §16)', () => {
    const broken = barsFromRows([...rowsOf(barsOf(BULL_FLAG, 60)).slice(0, 41), row(124.4, 125, 114.5, 115), ...rowsOf(barsOf(BULL_FLAG, 60)).slice(42)]);
    const [f] = ofType(run(broken, asOfAfter(broken, 42)), 'bull_flag');
    expect(f).toMatchObject({ status: 'invalidated' });
    expect(f!.invalidatedAt).toBe(broken[41]!.retrievedAt);
  });
});

describe('bull pennant golden (§23, §24, §36)', () => {
  const bars = barsOf(BULL_PENNANT, 60);

  it('forming while the pennant converges: direction neutral, the convergence and apex metrics exact in form', () => {
    const [p] = ofType(run(bars, asOfAfter(bars, 40)), 'bull_pennant');
    expect(p).toMatchObject({ status: 'forming', direction: 'neutral' });
    expect(Number(p!.geometryMetrics.convergence)).toBeGreaterThanOrEqual(0.3);
    expect(Number(p!.geometryMetrics.apexBarsAhead)).toBeLessThanOrEqual(20);
    expect(Number(p!.geometryMetrics.upperSlopeAtrPerBar)).toBeLessThan(-0.03);
    expect(Number(p!.geometryMetrics.lowerSlopeAtrPerBar)).toBeGreaterThan(0.03);
  });

  it('confirmed continuation in the pole direction at bar 42', () => {
    const [p] = ofType(run(bars, asOfAfter(bars, 42)), 'bull_pennant');
    expect(p).toMatchObject({ status: 'confirmed', direction: 'bullish', confirmation: { direction: 'up' } });
    expect(p!.confirmedAt).toBe(bars[42]!.retrievedAt);
  });

  it('the target is the pole length projected from the breakout (upper line 125.17 + 36 = 161.17)', () => {
    const [p] = ofType(run(bars, asOfAfter(bars, 46)), 'bull_pennant');
    expect(Number(p!.target.price)).toBeCloseTo(161.17, 2);
  });
});

describe('bear mirrors (§22, §23)', () => {
  it('the mirror of the bull flag is a bear flag: forming, then confirmed bearish on the downward break, with the same magnitudes', () => {
    const bear = barsOf(mirroredPivots(BULL_FLAG), 60);
    const [f] = ofType(run(bear, asOfAfter(bear, 41)), 'bear_flag');
    expect(f).toMatchObject({ status: 'confirmed', direction: 'bearish', confirmation: { direction: 'down' } });
    expect(Number(f!.target.price)).toBeCloseTo(200 - 160.25, 2);
  });

  it('the mirror of the bull pennant is a bear pennant', () => {
    const bear = barsOf(mirroredPivots(BULL_PENNANT), 60);
    const [p] = ofType(run(bear, asOfAfter(bear, 42)), 'bear_pennant');
    expect(p).toMatchObject({ status: 'confirmed', direction: 'bearish' });
  });
});

describe('pole policy (§14): exact decimal checks', () => {
  it('directional efficiency and the internal retracement are exact, and their thresholds are inclusive', () => {
    const closes = [100, 110, 104, 115].map((x) => Decimal.from(String(x)));
    const move = Decimal.from('15');
    const loose = resolvePatternParameters({ pole: { maxInternalRetracement: '0.4' } }).pole;
    const tight = resolvePatternParameters({ pole: { maxInternalRetracement: '0.39' } }).pole;
    expect(poleChecks(closes, move, loose)).toMatchObject({ accepted: true });
    expect(poleChecks(closes, move, tight)).toMatchObject({ accepted: false });
    expect(Number(poleChecks(closes, move, loose).retracement.toString())).toBe(0.4);
  });
});

describe('near misses (§37): each rule rejects on its own', () => {
  const bars = barsOf(BULL_FLAG, 60);
  const reject = (o: PatternParameterOverrides) => flags(run(bars, asOfAfter(bars, 41), { parameters: o })).filter((f) => f.patternType === 'bull_flag');

  it('a pole too small (move below minMoveAtr × ATR) is rejected', () => {
    expect(reject({ pole: { minMoveAtr: '20' } })).toEqual([]);
  });

  it('a pole too long (bars above maxBars) is rejected', () => {
    expect(reject({ pole: { maxBars: 10 } })).toEqual([]);
  });

  it('a consolidation too long for the pole (bars above maxBarsToPoleRatio × pole bars) is rejected', () => {
    expect(reject({ flag: { maxBarsToPoleRatio: '0.5' } })).toEqual([]);
  });

  it('a consolidation that retraces more than the limit of the pole is rejected', () => {
    expect(reject({ flag: { maxRetracementOfPole: '0.2' } })).toEqual([]);
  });

  it('a consolidation whose slope is rising beyond the flat tolerance is rejected (the wrong slope for a bull flag)', () => {
    expect(reject({ flag: { maxFlatSlopeAtrPerBar: '-0.5' } })).toEqual([]);
  });

  it('insufficient touches (fewer than the minimum per side) are rejected', () => {
    expect(reject({ flag: { minTouchesPerSide: 3 } })).toEqual([]);
  });

  it('a pennant that does not converge enough is rejected', () => {
    const pennant = barsOf(BULL_PENNANT, 60);
    const r = flags(run(pennant, asOfAfter(pennant, 42), { parameters: { pennant: { minConvergence: '0.9' } } }));
    expect(r.filter((f) => f.patternType === 'bull_pennant')).toEqual([]);
  });
});

describe('point-in-time and no look-ahead (§19, §20, §31)', () => {
  const bars = barsOf(BULL_FLAG, 60);

  it('a future swing cannot construct the pole early: no flag before its consolidation is confirmed; the shortest valid one (swing 34) is known at bar 37', () => {
    expect(flags(run(bars, asOfAfter(bars, 24)))).toEqual([]);
    expect(flags(run(bars, asOfAfter(bars, 36)))).toEqual([]);
    const at37 = flags(run(bars, asOfAfter(bars, 37)));
    expect(at37.length).toBeGreaterThanOrEqual(1);
    expect(at37[0]!.firstSeenAt).toBe(bars[37]!.retrievedAt);
  });

  it('the breakout cannot define its own pole: changing every bar after asOf 40 leaves the observation at 40 identical', () => {
    const changed = bars.map((b, i) => (i > 40 ? { ...b, high: b.high.plus(20), low: b.low.minus(9), close: b.close.minus(14) } : b));
    expect(flags(run(changed, asOfAfter(bars, 40))).map(strip)).toEqual(flags(run(bars, asOfAfter(bars, 40))).map(strip));
  });

  it('an unusable middle bar ends the prefix: the consolidation after it is never joined across the hole', () => {
    const gap = bars.map((b, i) => (i === 30 ? { ...b, isFinal: false } : b));
    expect(flags(run(gap, asOfAfter(gap, 41)))).toEqual([]);
  });
});

describe('ChartContext, scale and performance (§29, §38, §41)', () => {
  it('the same bars with a different ChartContext give the same flag geometry and lifecycle', () => {
    const bars = barsOf(BULL_FLAG, 60);
    const asOf = asOfAfter(bars, 41);
    const bullish = buildChartContext({ instrumentId: 'AAPL', asOf, requestedIntervals: ['1d'], runs: [quantRun({ label: 'bull', interval: '1d', trend: 'bullish', asOf })] });
    const bearish = buildChartContext({ instrumentId: 'AAPL', asOf, requestedIntervals: ['1d'], runs: [quantRun({ label: 'bear', interval: '1d', trend: 'bearish', asOf })] });
    const none = flags(run(bars, asOf)).map(strip);
    expect(flags(run(bars, asOf, { chartContext: bullish })).map(strip)).toEqual(none);
    expect(flags(run(bars, asOf, { chartContext: bearish })).map(strip)).toEqual(none);
  });

  it('a flag scaled by 10 keeps the type, the status and the normalized metrics; its prices scale by 10', () => {
    const base = barsOf(BULL_FLAG, 60);
    const big = scaled(base, 10);
    const a = ofType(run(base, asOfAfter(base, 41)), 'bull_flag')[0]!;
    const b = ofType(run(big, asOfAfter(big, 41)), 'bull_flag')[0]!;
    expect(b).toMatchObject({ status: a.status, direction: a.direction });
    expect(b.geometryMetrics.upperSlopeAtrPerBar).toBe(a.geometryMetrics.upperSlopeAtrPerBar);
    expect(b.geometryMetrics.poleBars).toBe(a.geometryMetrics.poleBars);
    expect(Number(b.anchors[1]!.price)).toBeCloseTo(Number(a.anchors[1]!.price) * 10, 6);
  });

  it('the flag search is bounded: the diagnostics expose the windows and pole checks, bounded by the swings', () => {
    const pivots: Array<[number, number]> = [];
    for (let i = 0, k = 0; i < 400; i += 4, k++) pivots.push([i, k % 2 === 0 ? 100 : 110]);
    const bars = barsOf(pivots, 400);
    const r = run(bars, asOfAfter(bars, 399));
    expect(r.diagnostics.flagWindows).toBeLessThanOrEqual(400 * 6);
    expect(r.diagnostics.flagPoleChecks).toBeLessThanOrEqual(400 * 6);
  });
});

/** The OHLC rows of a barsOf series, as rows, so one bar can be replaced. */
function rowsOf(bars: ReturnType<typeof barsOf>): ReturnType<typeof row>[] {
  return bars.map((b) => row(Number(b.open.toString()), Number(b.high.toString()), Number(b.low.toString()), Number(b.close.toString())));
}
