import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { runPatternEngine, type PatternRunInput } from '../../src/patterns/pattern-engine.js';
import { buildChartContext } from '../../src/timeframes/chart-context.js';
import { quantRun, ASOF } from '../timeframes/fixtures.js';
import { asOfAfter, barsOf, DESCENDING, DOUBLE_TOP, HS_TOP, INSTRUMENT_ID, mirroredPivots, scaled, SOURCE, SYMMETRICAL_DOWN, XNAS, ASCENDING } from './fixtures.js';

// Pattern Engine V1 structural core (docs/PATTERN_ENGINE_V1.md). Each test states one rule from the design.
// Observations are not ordered by pattern type, and one series can hold several structures at once (for example a double bottom inside a
// head and shoulders). A test therefore selects the observations of the type it is about; it never reads observations[0].

const instrument = { instrumentId: INSTRUMENT_ID, assetClass: 'stock' as const, allowsNegativePrices: false };
function input(bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}): PatternRunInput {
  return { instrument, calendar: XNAS, series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, replay: 'decision_time', ...extra };
}
const run = (bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}) => runPatternEngine(input(bars, asOf, extra));
const ofType = (r: ReturnType<typeof run>, type: string) => r.observations.filter((o) => o.patternType === type);
const hs = (r: ReturnType<typeof run>) => ofType(r, 'head_and_shoulders');

/** An observation without the identities that legitimately change with the run (the run fingerprint and the metadata). */
const strip = (o: { patternObservationId: string; evidenceRefs: unknown; chartContext: unknown }) => ({ ...o, patternObservationId: undefined, evidenceRefs: undefined, chartContext: undefined });

describe('point-in-time: nothing after asOf and nothing unproven enters a pattern', () => {
  it('bars after asOf are never used: the run on the full series equals the run on the series cut at asOf', () => {
    const bars = barsOf(HS_TOP, 65);
    const asOf = asOfAfter(bars, 47);
    const full = run(bars, asOf);
    const cut = run(bars.slice(0, 48), asOf);
    expect(full.observations.map(strip)).toEqual(cut.observations.map(strip));
    expect(hs(full)).toHaveLength(1);
  });

  it('a forming bar (not final) ends the usable series: the right shoulder is not confirmed while its confirming bar still forms', () => {
    const bars = barsOf(HS_TOP, 65).map((b, i) => (i === 45 ? { ...b, isFinal: false } : b));
    expect(hs(run(bars, asOfAfter(bars, 47)))).toEqual([]);
  });

  it('decision time: a bar NEXUS did not hold by asOf ends the usable series, and a legacy bar with no knowledge proof fails closed', () => {
    const bars = barsOf(HS_TOP, 65);
    const lateKnown = bars.map((b, i) => (i === 45 ? { ...b, knowledge: { ...b.knowledge, knownAt: '2026-12-31T00:00:00.000Z', knowledgeSource: 'provider_published_at' as const } } : b));
    expect(hs(run(lateKnown, asOfAfter(bars, 47)))).toEqual([]);
    const legacy = barsOf(HS_TOP, 65).map((b) => ({ ...b, knowledge: { knownAt: null, knowledgeSource: 'legacy_unproven' as const, vintage: 'legacy_unproven' as const, vintagePolicy: null } }));
    expect(() => run(legacy, asOfAfter(bars, 47))).toThrow(/knowledge/i);
  });

  it('historical research may use a bar NEXUS held only later, labelled as reconstruction; decision time may not', () => {
    const bars = barsOf(HS_TOP, 65).map((b, i) => (i === 45 ? { ...b, retrievedAt: '2027-06-01T00:00:00.000Z', knowledge: { knownAt: '2027-06-01T00:00:00.000Z', knowledgeSource: 'captured_by_nexus' as const, vintage: 'historical_reconstruction' as const, vintagePolicy: 'bar-vintage:v1' } } : b));
    expect(hs(run(bars, asOfAfter(bars, 47), { replay: 'historical_research' }))).toHaveLength(1);
    expect(hs(run(bars, asOfAfter(bars, 47), { replay: 'decision_time' }))).toEqual([]);
  });
});

describe('data quality gate', () => {
  it('an invalid bar series returns INVALID_DATA with its issues, and no pattern geometry is emitted', () => {
    const bars = barsOf(HS_TOP, 65).map((b, i) => (i === 30 ? { ...b, high: b.low.minus(1) } : b));
    const result = run(bars, asOfAfter(bars, 47));
    expect(result.status).toBe('INVALID_DATA');
    expect(result.observations).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('a series too short for the scale returns INSUFFICIENT_DATA, not a guessed tolerance', () => {
    const bars = barsOf(HS_TOP, 10);
    expect(run(bars, asOfAfter(bars, 9)).status).toBe('INSUFFICIENT_DATA');
  });
});

describe('head and shoulders golden progression (T1–T5)', () => {
  const bars = barsOf(HS_TOP, 65);

  it('T1: before the right shoulder is confirmed there is no head and shoulders', () => {
    expect(hs(run(bars, asOfAfter(bars, 43)))).toEqual([]);
  });

  it('T2: the right shoulder is confirmed, so the pattern is forming and firstSeenAt is the confirming bar', () => {
    const [o] = hs(run(bars, asOfAfter(bars, 45)));
    expect(o).toMatchObject({ patternType: 'head_and_shoulders', direction: 'bearish', status: 'forming', confirmedAt: null, resolvedAt: null });
    expect(o!.firstSeenAt).toBe(bars[45]!.retrievedAt);
    expect(o!.anchors.map((a) => a.role)).toEqual(['left_shoulder', 'neckline_left', 'head', 'neckline_right', 'right_shoulder']);
    expect(o!.anchors.map((a) => a.price)).toEqual(['110.5', '99.5', '120.5', '100.5', '111.5']);
  });

  it('T3: the first final close below the neckline confirms the breakdown on the next bar', () => {
    const [o] = hs(run(bars, asOfAfter(bars, 46)));
    expect(o).toMatchObject({ status: 'confirmed', confirmation: { direction: 'down' } });
    expect(o!.confirmedAt).toBe(bars[46]!.retrievedAt);
  });

  it('T4: confirmed earlier and not yet resolved: target_active', () => {
    expect(hs(run(bars, asOfAfter(bars, 50)))[0]).toMatchObject({ status: 'target_active' });
  });

  it('T5: the technical target is touched: completed', () => {
    expect(hs(run(bars, asOfAfter(bars, 56)))[0]).toMatchObject({ status: 'completed' });
  });

  it('the patternInstanceId is the same from the moment the geometry forms through completion; the observation id changes', () => {
    const ids = [45, 46, 50, 56].map((i) => hs(run(bars, asOfAfter(bars, i)))[0]!);
    expect(new Set(ids.map((o) => o.patternInstanceId)).size).toBe(1);
    expect(new Set(ids.map((o) => o.patternObservationId)).size).toBe(4);
  });

  it('the target is the head-to-neckline height projected down from the confirmation neckline (a technical target, not a return)', () => {
    const [o] = hs(run(bars, asOfAfter(bars, 56)));
    expect(o!.target.method).toBe('head_to_neckline_projected_from_confirmation');
    expect(Number(o!.target.price)).toBeGreaterThan(80);
    expect(Number(o!.target.price)).toBeLessThan(84);
  });
});

describe('head and shoulders: no look-ahead', () => {
  it('modifying every bar after T2 leaves the observation at T2 identical', () => {
    const bars = barsOf(HS_TOP, 65);
    const changed = bars.map((b, i) => (i > 45 ? { ...b, high: b.high.plus(50), low: b.low.minus(20), close: b.close.plus(7) } : b));
    const asOf = asOfAfter(bars, 45);
    expect(run(changed, asOf).observations.map(strip)).toEqual(run(bars, asOf).observations.map(strip));
  });

  it('an extreme bar that needs future right bars to be confirmed is not an anchor yet', () => {
    const bars = barsOf(HS_TOP, 65);
    expect(hs(run(bars, asOfAfter(bars, 43)))).toEqual([]);
  });
});

describe('mirror: inverse head and shoulders is the exact mirror of head and shoulders', () => {
  it('the mirrored golden series gives inverse_head_and_shoulders, bullish, confirmed up, with prices mirrored around 200', () => {
    const bars = barsOf(mirroredPivots(HS_TOP), 65);
    const [o] = ofType(run(bars, asOfAfter(bars, 46)), 'inverse_head_and_shoulders');
    expect(o).toMatchObject({ patternType: 'inverse_head_and_shoulders', direction: 'bullish', status: 'confirmed', confirmation: { direction: 'up' } });
    const original = hs(run(barsOf(HS_TOP, 65), asOfAfter(bars, 46)))[0]!;
    expect(o!.anchors.map((a) => Number(a.price))).toEqual(original.anchors.map((a) => 200 - Number(a.price)));
  });
});

describe('double top and double bottom', () => {
  it('a double top confirms on the breakdown below the neckline and completes at the target', () => {
    const bars = barsOf(DOUBLE_TOP, 60);
    const [forming] = ofType(run(bars, asOfAfter(bars, 33)), 'double_top');
    expect(forming).toMatchObject({ patternType: 'double_top', status: 'forming' });
    const [done] = ofType(run(bars, asOfAfter(bars, 45)), 'double_top');
    expect(done).toMatchObject({ status: 'completed' });
    expect(done!.anchors.map((a) => a.role)).toEqual(['first_peak', 'neckline', 'second_peak']);
  });

  it('a double bottom is the exact mirror of a double top', () => {
    const top = barsOf(DOUBLE_TOP, 60);
    const bottom = barsOf(mirroredPivots(DOUBLE_TOP), 60);
    const [a] = ofType(run(top, asOfAfter(top, 45)), 'double_top');
    const [b] = ofType(run(bottom, asOfAfter(bottom, 45)), 'double_bottom');
    expect(b).toMatchObject({ patternType: 'double_bottom', direction: 'bullish', status: a!.status });
    expect(b!.anchors.map((x) => Number(x.price))).toEqual(a!.anchors.map((x) => 200 - Number(x.price)));
  });
});

describe('triangles', () => {
  it('an ascending triangle: flat resistance, rising support, confirmed up through the upper line', () => {
    const bars = barsOf(ASCENDING, 62);
    const [o] = ofType(run(bars, asOfAfter(bars, 46)), 'ascending_triangle');
    expect(o).toMatchObject({ patternType: 'ascending_triangle', direction: 'bullish', status: 'confirmed', confirmation: { direction: 'up' } });
    expect(o!.confirmedAt).not.toBeNull();
  });

  it('the ascending triangle line metrics are exact: resistance flat, support rising', () => {
    const bars = barsOf(ASCENDING, 62);
    const [o] = ofType(run(bars, asOfAfter(bars, 47)), 'ascending_triangle');
    expect(Number(o!.geometryMetrics.upperSlopeAtrPerBar)).toBeCloseTo(0, 6);
    expect(Number(o!.geometryMetrics.lowerSlopeAtrPerBar)).toBeGreaterThan(0.03);
  });

  it('a descending triangle: flat support, falling resistance, confirmed down through the lower line', () => {
    const bars = barsOf(DESCENDING, 62);
    const [o] = ofType(run(bars, asOfAfter(bars, 47)), 'descending_triangle');
    expect(o).toMatchObject({ patternType: 'descending_triangle', direction: 'bearish', confirmation: { direction: 'down' } });
  });

  it('a symmetrical triangle is direction-neutral while it forms and is classified by the actual breakdown', () => {
    const bars = barsOf(SYMMETRICAL_DOWN, 62);
    const [o] = ofType(run(bars, asOfAfter(bars, 47)), 'symmetrical_triangle');
    expect(o).toMatchObject({ patternType: 'symmetrical_triangle', direction: 'bearish', confirmation: { direction: 'down' } });
  });

  it('a symmetrical triangle broken upward is bullish: the direction is not assumed in advance', () => {
    const up: Array<[number, number]> = [[0, 105], [12, 112], [18, 100], [24, 109], [30, 103], [36, 106], [42, 104.5], [46, 116], [52, 125], [60, 125]];
    const bars = barsOf(up, 62);
    const o = ofType(run(bars, asOfAfter(bars, 47)), 'symmetrical_triangle').find((x) => x.confirmation.direction === 'up');
    expect(o).toMatchObject({ patternType: 'symmetrical_triangle', direction: 'bullish', confirmation: { direction: 'up' } });
  });
});

describe('near misses: no visual closeness is accepted', () => {
  it('head and shoulders: unequal shoulders are rejected', () => {
    const pivots = HS_TOP.map(([i, p]) => (i === 42 ? [i, 100] : [i, p])) as Array<[number, number]>;
    const bars = barsOf(pivots, 65);
    expect(hs(run(bars, asOfAfter(bars, 46)))).toEqual([]);
  });

  it('head and shoulders: a head that is not prominent enough is rejected', () => {
    const pivots = HS_TOP.map(([i, p]) => (i === 26 ? [i, 112] : [i, p])) as Array<[number, number]>;
    const bars = barsOf(pivots, 65);
    expect(hs(run(bars, asOfAfter(bars, 46)))).toEqual([]);
  });

  it('head and shoulders: a steep neckline is rejected', () => {
    const pivots = HS_TOP.map(([i, p]) => (i === 34 ? [i, 80] : [i, p])) as Array<[number, number]>;
    const bars = barsOf(pivots, 65);
    expect(hs(run(bars, asOfAfter(bars, 46)))).toEqual([]);
  });

  it('head and shoulders: an asymmetric duration is rejected', () => {
    const pivots = HS_TOP.map(([i, p]) => (i === 42 ? [70, 111] : i === 48 ? [76, 92] : i === 56 ? [84, 80] : i === 64 ? [92, 80] : [i, p])) as Array<[number, number]>;
    const bars = barsOf(pivots, 100);
    expect(hs(run(bars, asOfAfter(bars, 74)))).toEqual([]);
  });

  it('head and shoulders: a pattern shorter than the minimum is rejected, and one longer than the maximum is rejected', () => {
    const short: Array<[number, number]> = [[0, 100], [10, 110], [13, 100], [16, 120], [19, 101], [22, 111], [28, 92], [36, 80]];
    const shortBars = barsOf(short, 45);
    expect(hs(run(shortBars, asOfAfter(shortBars, 26)))).toEqual([]);
    const bars = barsOf(HS_TOP, 65);
    expect(hs(run(bars, asOfAfter(bars, 46), { parameters: { headShoulders: { maxPatternBars: 20 } } }))).toEqual([]);
  });

  it('double top: peaks too far apart, a reaction too shallow, peaks too close, and a second peak not yet confirmed are rejected', () => {
    const far = DOUBLE_TOP.map(([i, p]) => (i === 30 ? [i, 116] : [i, p])) as Array<[number, number]>;
    const farBars = barsOf(far, 60);
    expect(ofType(run(farBars, asOfAfter(farBars, 45)), 'double_top')).toEqual([]);
    // The trough at 109 gives a reaction of 2.0 against 1.5 ATR (about 1.85 here): the shallow reaction is refused.
    const shallow = DOUBLE_TOP.map(([i, p]) => (i === 20 ? [i, 109] : [i, p])) as Array<[number, number]>;
    const shallowBars = barsOf(shallow, 60);
    expect(ofType(run(shallowBars, asOfAfter(shallowBars, 45)), 'double_top')).toEqual([]);
    const close: Array<[number, number]> = [[0, 100], [10, 110], [14, 100], [16, 110.5], [24, 95], [32, 85], [40, 85]];
    const closeBars = barsOf(close, 50);
    expect(ofType(run(closeBars, asOfAfter(closeBars, 40)), 'double_top')).toEqual([]);
    const bars = barsOf(DOUBLE_TOP, 60);
    expect(ofType(run(bars, asOfAfter(bars, 32)), 'double_top')).toEqual([]);
  });

  it('triangles: parallel lines that never converge, widening lines, and too few touches are all rejected', () => {
    const parallel: Array<[number, number]> = [[0, 100], [12, 110], [18, 100], [24, 110], [30, 100], [36, 110], [42, 100], [46, 114], [52, 125], [60, 125]];
    const pBars = barsOf(parallel, 62);
    expect(run(pBars, asOfAfter(pBars, 47)).observations.filter((o) => o.patternType.endsWith('triangle'))).toEqual([]);
    const widening: Array<[number, number]> = [[0, 100], [12, 110], [18, 104], [24, 112], [30, 100], [36, 114], [42, 96], [46, 80], [52, 70], [60, 70]];
    const wBars = barsOf(widening, 62);
    expect(run(wBars, asOfAfter(wBars, 47)).observations.filter((o) => o.patternType.endsWith('triangle'))).toEqual([]);
    const few: Array<[number, number]> = [[0, 100], [12, 110], [18, 101], [24, 110], [30, 100]];
    const fBars = barsOf(few, 40);
    expect(run(fBars, asOfAfter(fBars, 32)).observations.filter((o) => o.patternType.endsWith('triangle'))).toEqual([]);
  });

  it('triangles: a touch far off its line (residual too large) and a support that is not rising are rejected', () => {
    const off = ASCENDING.map(([i, p]) => (i === 24 ? [i, 120] : [i, p])) as Array<[number, number]>;
    const offBars = barsOf(off, 62);
    expect(ofType(run(offBars, asOfAfter(offBars, 47)), 'ascending_triangle')).toEqual([]);
    const notRising = ASCENDING.map(([i, p]) => (i === 18 || i === 30 || i === 42 ? [i, 101] : [i, p])) as Array<[number, number]>;
    const nrBars = barsOf(notRising, 62);
    expect(ofType(run(nrBars, asOfAfter(nrBars, 47)), 'ascending_triangle')).toEqual([]);
  });
});

describe('scale invariance', () => {
  it('multiplying every price by 10 keeps the type, the status and the direction; prices scale by 10', () => {
    const bars = barsOf(HS_TOP, 65);
    const big = scaled(bars, 10);
    const a = hs(run(bars, asOfAfter(bars, 46)))[0]!;
    const b = hs(run(big, asOfAfter(big, 46)))[0]!;
    expect(b).toMatchObject({ patternType: a.patternType, status: a.status, direction: a.direction });
    expect(b.anchors.map((x) => Number(x.price))).toEqual(a.anchors.map((x) => Number(x.price) * 10));
  });
});

describe('same-bar outcome ambiguity', () => {
  it('a bar that touches both the target and the failure boundary, with no ordering data, is outcome_ambiguous', () => {
    const bars = barsOf(HS_TOP, 65);
    const bad = bars.map((b, i) => (i === 49 ? { ...b, high: Decimal.from('104'), low: Decimal.from('80'), close: Decimal.from('90') } : b));
    const [o] = hs(run(bad, asOfAfter(bad, 50)));
    expect(o).toMatchObject({ status: 'outcome_ambiguous' });
    expect(o!.resolvedAt).not.toBeNull();
  });
});

describe('failure and expiry', () => {
  it('a confirmed breakdown closed back above the neckline is failed_breakout', () => {
    // The open of bar 47 is 98.33 (the previous close), so the low must not exceed it.
    const bars = barsOf(HS_TOP, 65).map((b, i) => (i === 47 ? { ...b, high: Decimal.from('105'), low: Decimal.from('97'), close: Decimal.from('104') } : b));
    expect(hs(run(bars, asOfAfter(bars, 47)))[0]).toMatchObject({ status: 'failed_breakout' });
  });

  it('a close above the right shoulder before confirmation invalidates the geometry', () => {
    // The open of bar 46 is 101.5 (the previous close), so the low must not exceed it.
    const bars = barsOf(HS_TOP, 65).map((b, i) => (i === 46 ? { ...b, high: Decimal.from('113'), low: Decimal.from('101'), close: Decimal.from('112') } : b));
    const [o] = hs(run(bars, asOfAfter(bars, 46)));
    expect(o).toMatchObject({ status: 'invalidated' });
    expect(o!.invalidatedAt).not.toBeNull();
  });

  it('no confirmation within the window after the geometry is known: expired', () => {
    const flat = [...HS_TOP.slice(0, 6), [60, 105] as const, [90, 105] as const].map(([i, p]) => [i, p] as [number, number]);
    const bars = barsOf(flat, 95);
    expect(hs(run(bars, asOfAfter(bars, 70)))[0]).toMatchObject({ status: 'expired' });
  });

  it('confirmed but no outcome within maxOutcomeBars: expired', () => {
    const bars = barsOf(HS_TOP, 65);
    expect(hs(run(bars, asOfAfter(bars, 53), { parameters: { outcome: { maxOutcomeBars: 5 } } }))[0]).toMatchObject({ status: 'expired' });
  });
});

describe('identity, order and provenance', () => {
  it('the same bars in a different order give the same run identity', () => {
    const bars = barsOf(HS_TOP, 65);
    const shuffled = [...bars].reverse();
    const a = run(bars, asOfAfter(bars, 46));
    const b = run(shuffled, asOfAfter(bars, 46));
    expect(b.patternRunId).toBe(a.patternRunId);
    expect(b.observations.map((o) => o.patternInstanceId)).toEqual(a.observations.map((o) => o.patternInstanceId));
  });

  it('createdAt is not part of the identity', () => {
    const bars = barsOf(HS_TOP, 65);
    expect(runPatternEngine(input(bars, asOfAfter(bars, 46)), { createdAt: '2026-01-01T00:00:00.000Z' }).patternRunId).toBe(
      runPatternEngine(input(bars, asOfAfter(bars, 46)), { createdAt: '2027-01-01T00:00:00.000Z' }).patternRunId,
    );
  });

  it('provenance answers both questions: captured bars are decision-time proven and not reconstructed', () => {
    const bars = barsOf(HS_TOP, 65);
    const r = run(bars, asOfAfter(bars, 46));
    expect(r.provenance).toMatchObject({ decisionTimeKnowledgeProven: true, historicalReconstruction: false, legacyUnproven: false });
  });

  it('every observation carries a unique patternInstanceId: duplicates from one detector are not emitted twice', () => {
    const bars = barsOf(HS_TOP, 65);
    const ids = run(bars, asOfAfter(bars, 56)).observations.map((o) => o.patternInstanceId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ChartContext: metadata only, and fail closed when it does not belong to the pattern', () => {
  const bars = barsOf(HS_TOP, 220);
  const asOf = asOfAfter(bars, 219);

  it('the same bars with different chart alignment give identical geometry and lifecycle; only the context metadata differs', () => {
    const bullish = buildChartContext({ instrumentId: 'AAPL', asOf: ASOF, requestedIntervals: ['1d'], runs: [quantRun({ label: 'bull', interval: '1d', trend: 'bullish' })] });
    const bearish = buildChartContext({ instrumentId: 'AAPL', asOf: ASOF, requestedIntervals: ['1d'], runs: [quantRun({ label: 'bear', interval: '1d', trend: 'bearish' })] });
    expect(asOf).toBe(ASOF);
    const none = run(bars, asOf).observations.map(strip);
    const a = run(bars, asOf, { chartContext: bullish }).observations;
    const b = run(bars, asOf, { chartContext: bearish }).observations;
    expect(a.map(strip)).toEqual(none);
    expect(b.map(strip)).toEqual(none);
    expect(a[0]!.chartContext).toMatchObject({ chartContextId: bullish.chartContextId });
    expect(b[0]!.chartContext).toMatchObject({ chartContextId: bearish.chartContextId });
    expect(a[0]!.chartContext!.chartContextId).not.toBe(b[0]!.chartContext!.chartContextId);
  });

  it('a context for another asOf is refused, never ignored', () => {
    const ctx = buildChartContext({ instrumentId: 'AAPL', asOf: ASOF, requestedIntervals: ['1d'], runs: [quantRun({ label: 'x', interval: '1d' })] });
    expect(() => run(bars, asOfAfter(bars, 100), { chartContext: ctx })).toThrow(/CHART_CONTEXT_MISMATCH|asOf/);
  });

  it('a context without the pattern interval is refused', () => {
    const ctx = buildChartContext({ instrumentId: 'AAPL', asOf: ASOF, requestedIntervals: ['1h'], runs: [quantRun({ label: 'h', interval: '1h' })] });
    expect(() => run(bars, asOf, { chartContext: ctx })).toThrow(/interval/);
  });
});

describe('mutation isolation', () => {
  it('bars, parameters and the output are not changed by a run, and the output is frozen', () => {
    const bars = barsOf(HS_TOP, 65);
    const params = { headShoulders: { maxPatternBars: 120 } };
    const before = hashOf({ bars, params });
    const r = run(bars, asOfAfter(bars, 56), { parameters: params });
    expect(hashOf({ bars, params })).toBe(before);
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => {
      (r as { status: string }).status = 'forged';
    }).toThrow();
  });
});

describe('bounded work', () => {
  it('candidates and walked bars stay within a bound proportional to the swings, on a long dense series', () => {
    const pivots: Array<[number, number]> = [];
    for (let i = 0, k = 0; i < 400; i += 4, k++) pivots.push([i, k % 2 === 0 ? 100 : 110]);
    const bars = barsOf(pivots, 400);
    const r = run(bars, asOfAfter(bars, 399));
    expect(r.diagnostics.candidateCount).toBeLessThanOrEqual(8 * r.diagnostics.swingCount + 8);
    expect(r.diagnostics.barsWalked).toBeLessThanOrEqual(r.diagnostics.candidateCount * 120 + 1);
  });
});
