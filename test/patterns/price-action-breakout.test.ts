import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import { levelIdentityOf } from '../../src/patterns/levels.js';
import { runPatternEngine, type PatternRunInput } from '../../src/patterns/pattern-engine.js';
import { buildPitView } from '../../src/patterns/pit-view.js';
import { buildChartContext } from '../../src/timeframes/chart-context.js';
import { quantRun } from '../timeframes/fixtures.js';
import { asOfAfter, barsOf, INSTRUMENT_ID, mirroredPivots, scaled, SOURCE, XNAS } from './fixtures.js';
import { FALSE_PIVOTS, RES_LATE_TOUCH_PIVOTS, RES_PIVOTS, withBar } from './price-action-fixtures.js';

// docs/PATTERN_ENGINE_V1B.md §5–§12, §16, §19–§23. Every expectation is derived from the pivot arithmetic in price-action-fixtures.ts.
// Resistance 110.5 (swings at 10 and 26), support 99.5 (swings at 18 and 34). Breakout at bar 41 (close 111.2 > 110.5 + buffer).

const instrument = { instrumentId: INSTRUMENT_ID, assetClass: 'stock' as const, allowsNegativePrices: false };
function input(bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}): PatternRunInput {
  return { instrument, calendar: XNAS, series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, replay: 'decision_time', ...extra };
}
const run = (bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}) => runPatternEngine(input(bars, asOf, extra));
const ofType = (r: ReturnType<typeof run>, type: string) => r.observations.filter((o) => o.patternType === type);
/** An observation without the identities that legitimately change with the run (the run fingerprint and the metadata). */
const strip = (o: { patternObservationId: string; evidenceRefs: unknown; chartContext: unknown }) => ({ ...o, patternObservationId: undefined, evidenceRefs: undefined, chartContext: undefined });

const RES = barsOf(RES_PIVOTS, 75);

describe('resistance breakout golden (§5, §8, §29)', () => {
  it('the close above resistance plus the buffer confirms a bullish breakout at bar 41, first seen at that bar', () => {
    const [b] = ofType(run(RES, asOfAfter(RES, 41)), 'resistance_breakout');
    expect(b).toMatchObject({ patternType: 'resistance_breakout', direction: 'bullish', status: 'confirmed', confirmation: { direction: 'up' } });
    expect(b!.firstSeenAt).toBe(RES[41]!.retrievedAt);
    expect(b!.confirmedAt).toBe(RES[41]!.retrievedAt);
    expect(Number(b!.confirmation.level)).toBe(110.5);
    expect(b!.anchors.map((a) => a.role)).toEqual(['resistance_touch_1', 'resistance_touch_2']);
    expect(b!.anchors.map((a) => Number(a.price))).toEqual([110.5, 110.5]);
  });

  it('before the breakout bar there is no breakout', () => {
    expect(ofType(run(RES, asOfAfter(RES, 40)), 'resistance_breakout')).toEqual([]);
  });

  it('the breakout is never confirmed by a wick alone: a bar that only pierces the level is not a breakout', () => {
    const bars = withBar(RES, 41, { high: '116', low: '108.5', close: '110.6' });
    expect(ofType(run(bars, asOfAfter(bars, 41)), 'resistance_breakout')).toEqual([]);
    expect(ofType(run(bars, asOfAfter(bars, 45)), 'resistance_breakout')).toEqual([]);
  });

  it('a close exactly at level plus buffer is not a breakout; one tick above is (strict comparison, exact decimals)', () => {
    const equal = withBar(barsOf(RES_PIVOTS, 75), 41, { high: '110.5', low: '108.5', close: '110.5' });
    const zeroBuffer = { parameters: { priceAction: { breakoutBufferAtr: '0' } } };
    expect(ofType(run(equal, asOfAfter(equal, 45), zeroBuffer), 'resistance_breakout')).toEqual([]);
    const above = withBar(barsOf(RES_PIVOTS, 75), 41, { high: '110.51', low: '108.5', close: '110.51' });
    const [b] = ofType(run(above, asOfAfter(above, 41), zeroBuffer), 'resistance_breakout');
    expect(b!.firstSeenAt).toBe(above[41]!.retrievedAt);
  });
});

describe('retest structure (§8.1, §9)', () => {
  it('a touch of the broken resistance that holds above it is retest_confirmed, the same breakout instance as before', () => {
    const [breakout41] = ofType(run(RES, asOfAfter(RES, 41)), 'resistance_breakout');
    const r = run(RES, asOfAfter(RES, 56));
    const [rt] = ofType(r, 'breakout_retest');
    expect(rt).toMatchObject({ patternType: 'breakout_retest', direction: 'bullish', status: 'retest_confirmed' });
    expect(rt!.firstSeenAt).toBe(RES[56]!.retrievedAt);
    expect(rt!.confirmedAt).toBe(RES[56]!.retrievedAt);
    const [breakout56] = ofType(r, 'resistance_breakout');
    expect(breakout56!.patternInstanceId).toBe(breakout41!.patternInstanceId);
    expect(rt!.patternInstanceId).not.toBe(breakout56!.patternInstanceId);
  });

  it('the same-bar rule: a breakout bar that also touches the zone creates no retest on that bar', () => {
    expect(ofType(run(RES, asOfAfter(RES, 41)), 'breakout_retest')).toEqual([]);
  });

  it('a touch without a hold is retest_pending; the next final close above the level confirms it, with the same retest instance', () => {
    const pending = withBar(RES, 56, { high: '112.6', low: '110.0', close: '110.4' });
    const [p] = ofType(run(pending, asOfAfter(pending, 56)), 'breakout_retest');
    expect(p).toMatchObject({ status: 'retest_pending' });
    expect(p!.confirmedAt).toBeNull();
    const [c] = ofType(run(pending, asOfAfter(pending, 57)), 'breakout_retest');
    expect(c).toMatchObject({ status: 'retest_confirmed' });
    expect(c!.patternInstanceId).toBe(p!.patternInstanceId);
    expect(c!.firstSeenAt).toBe(p!.firstSeenAt);
  });

  it('a touch that is not followed by a hold within the retest window expires', () => {
    const pending = withBar(RES, 56, { high: '112.6', low: '110.0', close: '110.4' });
    const [e] = ofType(run(pending, asOfAfter(pending, 62), { parameters: { priceAction: { retestWindowBars: 15 } } }), 'breakout_retest');
    expect(e).toMatchObject({ status: 'expired' });
  });

  it('a touch followed by a close back below the failure boundary fails: the retest and the false breakout both record failed_breakout', () => {
    const failing = withBar(withBar(RES, 56, { high: '112.6', low: '110.0', close: '110.4' }), 57, { high: '111.5', low: '109.0', close: '109.5' });
    const r = run(failing, asOfAfter(failing, 57), { parameters: { priceAction: { failureWindowBars: 20 } } });
    expect(ofType(r, 'breakout_retest')[0]).toMatchObject({ status: 'failed_breakout' });
    expect(ofType(r, 'false_breakout')[0]).toMatchObject({ status: 'failed_breakout', firstSeenAt: failing[57]!.retrievedAt });
  });
});

describe('false breakout (§8.3)', () => {
  const FALSE = barsOf(FALSE_PIVOTS, 60);

  it('a confirmed breakout closed back below the failure boundary within the window is a false_breakout at the failure bar', () => {
    const [b] = ofType(run(FALSE, asOfAfter(FALSE, 42)), 'resistance_breakout');
    expect(b).toMatchObject({ status: 'confirmed', firstSeenAt: FALSE[41]!.retrievedAt });
    const [f] = ofType(run(FALSE, asOfAfter(FALSE, 42)), 'false_breakout');
    expect(f).toMatchObject({ patternType: 'false_breakout', direction: 'bearish', status: 'failed_breakout' });
    expect(f!.firstSeenAt).toBe(FALSE[42]!.retrievedAt);
    expect(f!.resolvedAt).toBe(FALSE[42]!.retrievedAt);
  });

  it('no failure is known before the failure bar', () => {
    expect(ofType(run(FALSE, asOfAfter(FALSE, 41)), 'false_breakout')).toEqual([]);
  });

  it('a wick through the failure boundary whose close holds is not a failure (final-close failure policy)', () => {
    const wick = withBar(RES, 42, { high: '114.0', low: '108.0', close: '111.0' });
    const r = run(wick, asOfAfter(wick, 50));
    expect(ofType(r, 'false_breakout')).toEqual([]);
    expect(ofType(r, 'breakout_retest')[0]).toMatchObject({ status: 'retest_confirmed', firstSeenAt: wick[42]!.retrievedAt });
  });
});

describe('breakout identity, deduplication and look-ahead (§4.1, §5, §6, §7, §33)', () => {
  it('one breakout per level and direction: a re-cross of the same level is not a second breakout', () => {
    const recross = withBar(RES, 42, { high: '113.6', low: '110.0', close: '110.4' });
    const [only] = ofType(run(recross, asOfAfter(recross, 60)), 'resistance_breakout');
    expect(ofType(run(recross, asOfAfter(recross, 60)), 'resistance_breakout')).toHaveLength(1);
    expect(only!.firstSeenAt).toBe(recross[41]!.retrievedAt);
  });

  it('a later third touch creates a stronger level, but the earlier breakout does not acquire it (late level look-ahead)', () => {
    const late = barsOf(RES_LATE_TOUCH_PIVOTS, 100);
    const early = ofType(run(late, asOfAfter(late, 41)), 'resistance_breakout');
    const later = ofType(run(late, asOfAfter(late, 95)), 'resistance_breakout');
    expect(later).toHaveLength(1);
    expect(later[0]!.patternInstanceId).toBe(early[0]!.patternInstanceId);
    expect(later[0]!.anchors).toEqual(early[0]!.anchors);
    expect(later[0]!.boundaries).toEqual(early[0]!.boundaries);
    expect(later[0]!.anchors).toHaveLength(2);
  });

  it('retest no-look-ahead: arbitrary bars after the breakout leave the observations at that breakout byte-identical', () => {
    const changed = RES.map((b, i) => (i > 41 ? { ...b, high: b.high.plus(7), low: b.low.minus(3), close: b.close.minus(9) } : b));
    const asOf = asOfAfter(RES, 41);
    expect(run(changed, asOf).observations.map(strip)).toEqual(run(RES, asOf).observations.map(strip));
  });

  it('the breakout instance id is stable through its retest and failure; the retest and the false break have their own ids', () => {
    const ids = [41, 56, 70].map((i) => ofType(run(RES, asOfAfter(RES, i)), 'resistance_breakout')[0]!.patternInstanceId);
    expect(new Set(ids).size).toBe(1);
    const retest = ofType(run(RES, asOfAfter(RES, 70)), 'breakout_retest')[0]!;
    expect(retest.patternInstanceId).not.toBe(ids[0]);
    expect(ofType(run(RES, asOfAfter(RES, 60)), 'breakout_retest')[0]!.patternInstanceId).toBe(retest.patternInstanceId);
  });

  it('the level identity is canonical and never a rounded price: touch order does not matter, and two levels at one price differ by history', () => {
    const touch = (time: string, price: string) => ({ kind: 'high' as const, price: Decimal.from(price), time });
    const level = { priceLevel: Decimal.from('110.5'), confirmedAt: '2026-02-03T21:01:00.000Z', touches: [touch('2026-01-20T00:00:00.000Z', '110.5'), touch('2026-02-02T00:00:00.000Z', '110.5')] };
    const reversed = { ...level, touches: [...level.touches].reverse() };
    expect(levelIdentityOf(level, '1d')).toBe(levelIdentityOf(reversed, '1d'));
    const other = { ...level, confirmedAt: '2026-03-05T21:01:00.000Z' };
    expect(levelIdentityOf(other, '1d')).not.toBe(levelIdentityOf(level, '1d'));
  });

  it('the run identity depends on the retest and failure parameters, and carries the support/resistance version', () => {
    const a = run(RES, asOfAfter(RES, 56));
    const b = run(RES, asOfAfter(RES, 56), { parameters: { priceAction: { retestWindowBars: 15 } } });
    expect(b.patternRunId).not.toBe(a.patternRunId);
    expect(a.engineVersion).toBe('pattern-engine:v1b');
    expect(a.supportResistanceVersion).toBe('sr:swing-cluster:v1');
    expect(a.priceActionLifecycleVersion).toBe('price-action-lifecycle:v1');
  });
});

describe('mirror: breakdowns are the exact mirror of breakouts (§5, §8)', () => {
  it('a support breakdown at 41, a bearish retest confirmed at 56, and a false breakdown at 42', () => {
    const down = barsOf(mirroredPivots(RES_PIVOTS), 75);
    const [b] = ofType(run(down, asOfAfter(down, 41)), 'support_breakdown');
    expect(b).toMatchObject({ direction: 'bearish', status: 'confirmed', confirmation: { direction: 'down' } });
    expect(Number(b!.confirmation.level)).toBe(89.5);
    expect(ofType(run(down, asOfAfter(down, 56)), 'breakdown_retest')[0]).toMatchObject({ status: 'retest_confirmed', direction: 'bearish' });
    const falseDown = barsOf(mirroredPivots(FALSE_PIVOTS), 60);
    expect(ofType(run(falseDown, asOfAfter(falseDown, 42)), 'false_breakdown')[0]).toMatchObject({ status: 'failed_breakout', direction: 'bullish' });
  });
});

describe('point-in-time: nothing unusable forms a breakout (§3, §23)', () => {
  it('a non-final bar at 40 ends the usable series, so the breakout at 41 is never formed', () => {
    const gap = RES.map((b, i) => (i === 40 ? { ...b, isFinal: false } : b));
    const r = run(gap, asOfAfter(gap, 60));
    expect(ofType(r, 'resistance_breakout')).toEqual([]);
    expect(ofType(r, 'breakout_retest')).toEqual([]);
    expect(buildPitView(gap, asOfAfter(gap, 60), 'decision_time').bars.map((p) => p.index)).toHaveLength(40);
  });
});

describe('scale invariance and ChartContext independence (§25, §40)', () => {
  it('multiplying every price by 10 keeps the types and statuses; the level and the anchors scale by 10', () => {
    const big = scaled(RES, 10);
    const pairs = (bars: typeof RES) => run(bars, asOfAfter(bars, 56)).observations.map((o) => `${o.patternType}:${o.status}`).sort();
    expect(pairs(big)).toEqual(pairs(RES));
    const [lvl] = ofType(run(big, asOfAfter(big, 41)), 'resistance_breakout');
    expect(Number(lvl!.confirmation.level)).toBe(1105);
    expect(lvl!.anchors.map((x) => Number(x.price))).toEqual([1105, 1105]);
  });

  it('the same bars with different chart alignment give identical breakout geometry and lifecycle', () => {
    // The contexts are built at the run's own asOf: a context for another asOf is refused (V1 rule, docs/PATTERN_ENGINE_V1.md).
    const asOf = asOfAfter(RES, 56);
    const bullish = buildChartContext({ instrumentId: 'AAPL', asOf, requestedIntervals: ['1d'], runs: [quantRun({ label: 'bull', interval: '1d', trend: 'bullish', asOf })] });
    const bearish = buildChartContext({ instrumentId: 'AAPL', asOf, requestedIntervals: ['1d'], runs: [quantRun({ label: 'bear', interval: '1d', trend: 'bearish', asOf })] });
    const none = run(RES, asOf).observations.map(strip);
    expect(run(RES, asOf, { chartContext: bullish }).observations.map(strip)).toEqual(none);
    expect(run(RES, asOf, { chartContext: bearish }).observations.map(strip)).toEqual(none);
  });
});

describe('mutation isolation and determinism for price-action output (§16, §44)', () => {
  it('a price-action run is frozen, and the same bars in another order give the same run and observation identities', () => {
    const r = run(RES, asOfAfter(RES, 56));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.observations[0])).toBe(true);
    const shuffled = [...RES].reverse();
    const again = run(shuffled, asOfAfter(RES, 56));
    expect(again.patternRunId).toBe(r.patternRunId);
    expect(again.observations.map((o) => o.patternObservationId)).toEqual(r.observations.map((o) => o.patternObservationId));
  });
});

describe('bounded work (§18, §43)', () => {
  it('level evaluations and walked bars stay within the bounds of the level family and the windows', () => {
    const pivots: Array<[number, number]> = [];
    for (let i = 0, k = 0; i < 400; i += 4, k++) pivots.push([i, k % 2 === 0 ? 100 : 110]);
    const bars = barsOf(pivots, 400);
    const r = run(bars, asOfAfter(bars, 399));
    expect(r.diagnostics.levelEvaluations).toBeLessThanOrEqual(400);
    expect(r.diagnostics.priceActionBarsWalked).toBeLessThanOrEqual(r.diagnostics.breakoutCount * 21 + 1);
    expect(r.diagnostics.channelWedgeWindows).toBeLessThanOrEqual(400 * 6);
  });
});
