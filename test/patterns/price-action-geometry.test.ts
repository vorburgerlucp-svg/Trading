import { describe, expect, it } from 'vitest';
import { runPatternEngine, type PatternRunInput } from '../../src/patterns/pattern-engine.js';
import { asOfAfter, barsOf, mirroredPivots, scaled, SOURCE, XNAS, INSTRUMENT_ID, ASCENDING } from './fixtures.js';
import { ASC_CHANNEL_PIVOTS, RECT_PIVOTS, WEDGE_RISING_DOWN_PIVOTS, WEDGE_RISING_UP_PIVOTS } from './price-action-fixtures.js';

// docs/PATTERN_ENGINE_V1B.md §10–§15. Rectangles come from support/resistance clusters; channels and wedges from fitted swing lines. Both
// breakout directions are tested for the wedges. No textbook direction is assumed.

const instrument = { instrumentId: INSTRUMENT_ID, assetClass: 'stock' as const, allowsNegativePrices: false };
function input(bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}): PatternRunInput {
  return { instrument, calendar: XNAS, series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, replay: 'decision_time', ...extra };
}
const run = (bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}) => runPatternEngine(input(bars, asOf, extra));
const ofType = (r: ReturnType<typeof run>, type: string) => r.observations.filter((o) => o.patternType === type);
const CHANNEL_TYPES = ['ascending_channel', 'descending_channel'];
const WEDGE_TYPES = ['rising_wedge', 'falling_wedge'];
const TRIANGLE_TYPES = ['ascending_triangle', 'descending_triangle', 'symmetrical_triangle'];

describe('rectangle (§10)', () => {
  const RECT = barsOf(RECT_PIVOTS, 75);

  it('the pair is born when the later of its two levels is confirmed: forming, neutral, first seen at that bar', () => {
    const [rect] = ofType(run(RECT, asOfAfter(RECT, 40)), 'rectangle').filter((o) => o.firstSeenAt === RECT[37]!.retrievedAt);
    expect(rect).toMatchObject({ status: 'forming', direction: 'neutral' });
    expect(rect!.anchors.map((a) => a.role)).toEqual(['resistance_touch_1', 'resistance_touch_2', 'support_touch_1', 'support_touch_2']);
    expect(Number(rect!.boundaries.upper!.intercept)).toBe(110.5);
    expect(Number(rect!.boundaries.lower!.intercept)).toBe(99.5);
    expect(rect!.geometryMetrics).toMatchObject({ durationBars: '24', upperTouches: '2', lowerTouches: '2' });
  });

  it('a close above the upper boundary plus the buffer confirms an upward break at 56; the same rectangle, still one instance', () => {
    const [before] = ofType(run(RECT, asOfAfter(RECT, 40)), 'rectangle').filter((o) => o.firstSeenAt === RECT[37]!.retrievedAt);
    const [after] = ofType(run(RECT, asOfAfter(RECT, 56)), 'rectangle').filter((o) => o.firstSeenAt === RECT[37]!.retrievedAt);
    expect(after).toMatchObject({ status: 'confirmed', direction: 'bullish', confirmation: { direction: 'up' } });
    expect(after!.patternInstanceId).toBe(before!.patternInstanceId);
    expect(ofType(run(RECT, asOfAfter(RECT, 56)), 'rectangle').filter((o) => o.firstSeenAt === RECT[37]!.retrievedAt)).toHaveLength(1);
  });

  it('the technical target is the rectangle height projected from the break (110.5 + 11 = 121.5), and is completed when reached', () => {
    const [done] = ofType(run(RECT, asOfAfter(RECT, 62)), 'rectangle').filter((o) => o.firstSeenAt === RECT[37]!.retrievedAt);
    expect(done).toMatchObject({ status: 'completed', target: { method: 'rectangle_height_projected_from_break' } });
    expect(Number(done!.target.price)).toBe(121.5);
  });

  it('the same break is also a standalone resistance_breakout: overlapping structures are allowed', () => {
    expect(ofType(run(RECT, asOfAfter(RECT, 56)), 'resistance_breakout')).toHaveLength(1);
  });

  it('near miss: a single support touch is not a rectangle', () => {
    const oneSupport = RECT_PIVOTS.map(([i, p]) => (i === 34 ? [i, 104] : [i, p])) as Array<[number, number]>;
    const bars = barsOf(oneSupport, 75);
    expect(ofType(run(bars, asOfAfter(bars, 45)), 'rectangle')).toEqual([]);
  });

  it('near miss: bounds that widen (a drifting touch within the cluster tolerance) fail the flatness rule', () => {
    const drift = RECT_PIVOTS.map(([i, p]) => (i === 26 ? [i, 111] : [i, p])) as Array<[number, number]>;
    const bars = barsOf(drift, 75);
    expect(ofType(run(bars, asOfAfter(bars, 45)), 'rectangle')).toEqual([]);
  });

  it('near miss: a range narrower than the ATR minimum is not a rectangle (the same range fails at a larger minimum height)', () => {
    expect(ofType(run(RECT, asOfAfter(RECT, 40), { parameters: { rectangle: { minHeightAtr: '10' } } }), 'rectangle')).toEqual([]);
  });

  it('near miss: too short and too long are both rejected (duration bounds)', () => {
    const short: Array<[number, number]> = [[0, 100], [4, 110], [8, 100], [12, 110], [16, 100], [20, 110], [24, 100]];
    const shortBars = barsOf(short, 40);
    expect(ofType(run(shortBars, asOfAfter(shortBars, 30)), 'rectangle')).toEqual([]);
    expect(ofType(run(RECT, asOfAfter(RECT, 40), { parameters: { rectangle: { maxDurationBars: 20 } } }), 'rectangle')).toEqual([]);
  });

  it('the mirror of a rectangle is a rectangle with the same geometry: an upward break becomes a downward break, target 200 − 121.5', () => {
    const down = barsOf(mirroredPivots(RECT_PIVOTS), 75);
    const [d] = ofType(run(down, asOfAfter(down, 56)), 'rectangle').filter((o) => o.firstSeenAt === down[37]!.retrievedAt);
    expect(d).toMatchObject({ status: 'confirmed', direction: 'bearish', confirmation: { direction: 'down' } });
    expect(Number(d!.target.price)).toBe(78.5);
  });
});

describe('ascending and descending channel (§11, §16)', () => {
  const CH = barsOf(ASC_CHANNEL_PIVOTS, 80);
  const formedAt51 = (r: ReturnType<typeof run>) => r.observations.filter((o) => CHANNEL_TYPES.includes(o.patternType) && o.firstSeenAt === CH[51]!.retrievedAt);

  it('golden: a parallel rising channel is forming, neutral, first seen at its last confirmed swing (bar 51)', () => {
    const [ch] = formedAt51(run(CH, asOfAfter(CH, 51)));
    expect(ch).toMatchObject({ patternType: 'ascending_channel', status: 'forming', direction: 'neutral' });
    expect(ch!.geometryMetrics).toMatchObject({ durationBars: '30', upperTouches: '3', lowerTouches: '3', slopeDifferenceAtrPerBar: '0.000000', maxResidualAtr: '0.000000' });
    expect(Number(ch!.geometryMetrics.upperSlopeAtrPerBar)).toBeGreaterThan(0.03);
    expect(Number(ch!.geometryMetrics.widthStartAtr)).toBeCloseTo(Number(ch!.geometryMetrics.widthEndAtr), 6);
  });

  it('a close above the upper line plus the buffer breaks it up at bar 73: confirmed, bullish; the type stays ascending_channel', () => {
    const [ch] = formedAt51(run(CH, asOfAfter(CH, 73)));
    expect(ch).toMatchObject({ patternType: 'ascending_channel', status: 'confirmed', direction: 'bullish', confirmation: { direction: 'up' } });
  });

  it('the mirror of a rising channel is a falling channel with the same metrics, and a descending channel is never assumed bearish', () => {
    const down = barsOf(mirroredPivots(ASC_CHANNEL_PIVOTS), 80);
    const [ch] = down.length ? run(down, asOfAfter(down, 51)).observations.filter((o) => o.patternType === 'descending_channel' && o.firstSeenAt === down[51]!.retrievedAt) : [];
    expect(ch).toMatchObject({ patternType: 'descending_channel', status: 'forming', direction: 'neutral' });
    expect(Number(ch!.geometryMetrics.upperSlopeAtrPerBar)).toBeLessThan(-0.03);
  });

  it('near miss: slopes in opposite directions (diverging lines) are no channel', () => {
    const diverge: Array<[number, number]> = [[12, 110], [18, 100], [24, 113], [30, 98], [36, 116], [42, 96], [48, 119], [54, 94], [60, 122], [66, 92]];
    const bars = barsOf(diverge, 80);
    expect(run(bars, asOfAfter(bars, 70)).observations.filter((o) => CHANNEL_TYPES.includes(o.patternType))).toEqual([]);
  });

  it('near miss: a width that expands beyond the stability tolerance is rejected', () => {
    const widen: Array<[number, number]> = [[12, 110], [18, 100], [24, 113], [30, 101.8], [36, 116], [42, 103.6], [48, 119], [54, 105.4], [60, 122], [66, 107.2]];
    const bars = barsOf(widen, 80);
    expect(run(bars, asOfAfter(bars, 70)).observations.filter((o) => CHANNEL_TYPES.includes(o.patternType))).toEqual([]);
  });

  it('near miss: a touch far off the fitted line (residual) leaves no three-touch channel', () => {
    const off = ASC_CHANNEL_PIVOTS.map(([i, p]) => (i === 36 ? [i, 122] : [i, p])) as Array<[number, number]>;
    const bars = barsOf(off, 80);
    const threeTouch = run(bars, asOfAfter(bars, 70)).observations.filter((o) => CHANNEL_TYPES.includes(o.patternType) && o.geometryMetrics.upperTouches === '3');
    expect(threeTouch).toEqual([]);
  });

  it('near miss: too few swings (fewer than two per side) and a duration below the minimum are rejected', () => {
    const three: Array<[number, number]> = [[12, 110], [18, 100], [24, 113]];
    const threeBars = barsOf(three, 40);
    expect(run(threeBars, asOfAfter(threeBars, 30)).observations.filter((o) => CHANNEL_TYPES.includes(o.patternType))).toEqual([]);
    const compact: Array<[number, number]> = [[8, 110], [12, 100], [16, 112], [20, 102]];
    const compactBars = barsOf(compact, 24);
    expect(run(compactBars, asOfAfter(compactBars, 21)).observations.filter((o) => CHANNEL_TYPES.includes(o.patternType))).toEqual([]);
  });
});

describe('rising and falling wedge (§12, §18)', () => {
  const DOWN = barsOf(WEDGE_RISING_DOWN_PIVOTS, 60);
  const UP = barsOf(WEDGE_RISING_UP_PIVOTS, 60);
  const wedgeFormedAt45 = (r: ReturnType<typeof run>, bars: typeof DOWN) => r.observations.filter((o) => WEDGE_TYPES.includes(o.patternType) && o.firstSeenAt === bars[45]!.retrievedAt);

  it('golden: a rising wedge forms neutral at its last swing (bar 45), with converging, steeper support', () => {
    const [w] = wedgeFormedAt45(run(DOWN, asOfAfter(DOWN, 45)), DOWN);
    expect(w).toMatchObject({ patternType: 'rising_wedge', status: 'forming', direction: 'neutral' });
    expect(Number(w!.geometryMetrics.lowerSlopeAtrPerBar)).toBeGreaterThan(Number(w!.geometryMetrics.upperSlopeAtrPerBar));
    expect(Number(w!.geometryMetrics.convergence)).toBeGreaterThanOrEqual(0.2);
  });

  it('a rising wedge can break down: confirmed bearish at bar 47', () => {
    const [w] = wedgeFormedAt45(run(DOWN, asOfAfter(DOWN, 47)), DOWN);
    expect(w).toMatchObject({ patternType: 'rising_wedge', status: 'confirmed', direction: 'bearish', confirmation: { direction: 'down' } });
  });

  it('a rising wedge can also break up: confirmed bullish at bar 48, with the same type', () => {
    const [w] = wedgeFormedAt45(run(UP, asOfAfter(UP, 48)), UP);
    expect(w).toMatchObject({ patternType: 'rising_wedge', status: 'confirmed', direction: 'bullish', confirmation: { direction: 'up' } });
  });

  it('the mirror of a rising wedge is a falling wedge, and both of its breakouts are legitimate', () => {
    const fallingDown = barsOf(mirroredPivots(WEDGE_RISING_UP_PIVOTS), 60);
    const fallingUp = barsOf(mirroredPivots(WEDGE_RISING_DOWN_PIVOTS), 60);
    const [a] = run(fallingDown, asOfAfter(fallingDown, 48)).observations.filter((o) => o.patternType === 'falling_wedge' && o.firstSeenAt === fallingDown[45]!.retrievedAt);
    const [b] = run(fallingUp, asOfAfter(fallingUp, 47)).observations.filter((o) => o.patternType === 'falling_wedge' && o.firstSeenAt === fallingUp[45]!.retrievedAt);
    expect(a).toMatchObject({ status: 'confirmed', direction: 'bearish' });
    expect(b).toMatchObject({ status: 'confirmed', direction: 'bullish' });
  });

  it('classification: a wedge fixture yields no triangle and no channel', () => {
    const types = run(DOWN, asOfAfter(DOWN, 47)).observations.map((o) => o.patternType);
    expect(types.filter((t) => TRIANGLE_TYPES.includes(t) || CHANNEL_TYPES.includes(t))).toEqual([]);
  });

  it('classification: a triangle with a flat top is a triangle, not a wedge', () => {
    const bars = barsOf(ASCENDING, 62);
    const r = run(bars, asOfAfter(bars, 46));
    expect(r.observations.filter((o) => o.patternType === 'ascending_triangle')).not.toEqual([]);
    expect(r.observations.filter((o) => WEDGE_TYPES.includes(o.patternType))).toEqual([]);
  });

  it('classification: a channel is never reported as a wedge', () => {
    const bars = barsOf(ASC_CHANNEL_PIVOTS, 80);
    const r = run(bars, asOfAfter(bars, 73));
    expect(r.observations.filter((o) => CHANNEL_TYPES.includes(o.patternType))).not.toEqual([]);
    expect(r.observations.filter((o) => WEDGE_TYPES.includes(o.patternType))).toEqual([]);
  });

  it('near miss: an apex farther ahead than the maximum is not a wedge', () => {
    const r = run(DOWN, asOfAfter(DOWN, 47), { parameters: { wedge: { maxApexBarsAhead: 40 } } });
    expect(r.observations.filter((o) => WEDGE_TYPES.includes(o.patternType))).toEqual([]);
  });
});

describe('scale invariance for the new structures (§40)', () => {
  it('a rectangle scaled by 10 keeps type, status and metrics; its target and boundaries scale by 10', () => {
    const base = barsOf(RECT_PIVOTS, 75);
    const big = scaled(base, 10);
    const pick = (bars: typeof base) => run(bars, asOfAfter(bars, 62)).observations.find((o) => o.patternType === 'rectangle' && o.firstSeenAt === bars[37]!.retrievedAt)!;
    const a = pick(base);
    const b = pick(big);
    expect(b).toMatchObject({ patternType: a.patternType, status: a.status, direction: a.direction });
    // The lineage ids hash the prices, so they change with the scale, as the instance ids do. Every other metric is scale-free.
    const withoutLineage = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.endsWith('LineageId')));
    expect(withoutLineage(b.geometryMetrics)).toEqual(withoutLineage(a.geometryMetrics));
    expect(Number(b.target.price)).toBe(Number(a.target.price) * 10);
    expect(Number(b.boundaries.upper!.intercept)).toBe(Number(a.boundaries.upper!.intercept) * 10);
  });

  it('a channel scaled by 10 keeps type, status and normalized slope metrics; its boundaries scale by 10', () => {
    // The same structure is selected in both runs by its geometry-known bar: observation order is by id, and ids depend on prices.
    const base = barsOf(ASC_CHANNEL_PIVOTS, 80);
    const big = scaled(base, 10);
    const pick = (bars: typeof base) => run(bars, asOfAfter(bars, 73)).observations.find((o) => o.patternType === 'ascending_channel' && o.firstSeenAt === bars[51]!.retrievedAt)!;
    const a = pick(base);
    const b = pick(big);
    expect(b).toMatchObject({ patternType: a.patternType, status: a.status, direction: a.direction });
    expect(b.geometryMetrics.upperSlopeAtrPerBar).toBe(a.geometryMetrics.upperSlopeAtrPerBar);
    expect(Number(b.boundaries.upper!.intercept)).toBeCloseTo(Number(a.boundaries.upper!.intercept) * 10, 6);
  });
});
