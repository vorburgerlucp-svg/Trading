import { describe, expect, it } from 'vitest';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { quantResultHash } from '../../src/quant/quant-engine.js';
import { alignmentOf, phaseOf, type LayerTrend } from '../../src/timeframes/alignment.js';
import { buildChartContext, ChartContextError, type ChartContextPolicy } from '../../src/timeframes/chart-context.js';
import { DEFAULT_HIERARCHY } from '../../src/timeframes/timeframe-hierarchy.js';
import { ASOF, quantRun, trendRun } from './fixtures.js';

// Multi-timeframe / whole-chart context V1 (docs/MULTITIMEFRAME_CHART_CONTEXT_V1.md). Each test states one rule from the design.

const FULL: Parameters<typeof buildChartContext>[0]['requestedIntervals'] = ['15m', '1h', '4h', '1d'];
const ctx = (runs: ReturnType<typeof quantRun>[], requestedIntervals: Parameters<typeof buildChartContext>[0]['requestedIntervals'] = FULL, policy?: ChartContextPolicy) =>
  buildChartContext({ instrumentId: 'AAPL', asOf: ASOF, requestedIntervals, runs }, policy);

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

const FORBIDDEN_ACTIONS = /\b(buy|sell|long_setup|short_setup|enter|exit|probability|target|stop_loss|position_size)\b/i;

describe('inputs are verified and coherent (fail closed)', () => {
  it('a corrupted QuantResult whose stored hash no longer matches is refused', () => {
    const run = trendRun('1h', 'bullish');
    const corrupted = { ...run, result: { ...run.result, marketStructure: { ...run.result.marketStructure, trend: 'bearish' as const } } };
    expect(() => ctx([corrupted, trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('15m', 'bullish')])).toThrow(ChartContextError);
    expect(() => ctx([corrupted, trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('15m', 'bullish')])).toThrow(/CHART_QUANT_UNVERIFIED|does not match/);
  });

  it('a corrupted structure whose hash was recomputed is still refused: the labels must agree with the trend', () => {
    const forged = quantRun({ label: 'forged', interval: '1h', trend: 'bullish', lastHighLabel: 'LH', lastLowLabel: 'HL' });
    expect(thrownBy(() => ctx([forged]))).toMatchObject({ code: 'CHART_STRUCTURE_INCONSISTENT' });
  });

  it('a run whose quantRunId does not derive from its input fingerprint is refused', () => {
    const run = trendRun('1h', 'bullish');
    const retargeted = { ...run, result: { ...run.result, quantRunId: 'qr_' + 'a'.repeat(40) } };
    const rehashed = { ...retargeted, resultHash: quantResultHash(retargeted.result) };
    expect(() => ctx([rehashed])).toThrow(ChartContextError);
  });

  it('an unknown or future Quant engine version is refused, never silently consumed', () => {
    expect(thrownBy(() => ctx([quantRun({ label: 'v4', interval: '1h', engineVersion: 'quant-engine:v4' })]))).toMatchObject({ code: 'CHART_ENGINE_UNSUPPORTED' });
  });

  it('an include_in_progress run is refused: V1 is final-only', () => {
    expect(thrownBy(() => ctx([quantRun({ label: 'live', interval: '1h', mode: 'include_in_progress' })], ['1h']))).toMatchObject({ code: 'CHART_IN_PROGRESS_REFUSED' });
  });

  it('only native intervals are accepted', () => {
    expect(thrownBy(() => ctx([quantRun({ label: 'w', interval: '30m' as never })], ['30m' as never]))).toMatchObject({ code: 'CHART_NOT_NATIVE' });
  });

  it('two different instruments in one context are refused', () => {
    expect(thrownBy(() => ctx([trendRun('1h', 'bullish'), quantRun({ label: 'msft', interval: '1d', instrumentId: 'MSFT' })]))).toMatchObject({ code: 'CHART_INPUT_MISMATCH' });
  });

  it('two different asOf values are refused: nothing is normalised silently', () => {
    expect(thrownBy(() => ctx([trendRun('1h', 'bullish'), quantRun({ label: 'late', interval: '1d', asOf: '2026-10-09T00:00:00.000Z' })]))).toMatchObject({ code: 'CHART_INPUT_MISMATCH' });
  });

  it('a different source, session, adjustment or use case is refused: raw and split-adjusted are never one chart', () => {
    expect(thrownBy(() => ctx([trendRun('1h', 'bullish'), quantRun({ label: 's', interval: '1d', source: 'other:source' })]))).toMatchObject({ code: 'CHART_INPUT_MISMATCH' });
    expect(thrownBy(() => ctx([trendRun('1h', 'bullish'), quantRun({ label: 'a', interval: '1d', adjustment: 'split_adjusted' })]))).toMatchObject({ code: 'CHART_INPUT_MISMATCH' });
    expect(thrownBy(() => ctx([trendRun('1h', 'bullish'), quantRun({ label: 'se', interval: '1d', session: 'extended' })]))).toMatchObject({ code: 'CHART_INPUT_MISMATCH' });
    expect(thrownBy(() => ctx([trendRun('1h', 'bullish'), quantRun({ label: 'u', interval: '1d', useCase: 'trading' })]))).toMatchObject({ code: 'CHART_INPUT_MISMATCH' });
  });

  it('historical research mixed with decision-time replay is refused', () => {
    expect(thrownBy(() => ctx([trendRun('1h', 'bullish'), quantRun({ label: 'hist', interval: '1d', barReplay: 'historical_research' })]))).toMatchObject({ code: 'CHART_INPUT_MISMATCH' });
  });

  it('two runs of the same interval are refused; the context never picks one by order or time', () => {
    expect(thrownBy(() => ctx([trendRun('1h', 'bullish', { label: 'a' }), trendRun('1h', 'bearish', { label: 'b' })]))).toMatchObject({ code: 'CHART_DUPLICATE_INTERVAL' });
  });

  it('a run for an interval that was not requested is refused', () => {
    expect(thrownBy(() => ctx([trendRun('1h', 'bullish'), trendRun('5m', 'bullish')], ['1h']))).toMatchObject({ code: 'CHART_INTERVAL_NOT_REQUESTED' });
  });
});

describe('timeframe states carry the deterministic values, and invalid data is never copied', () => {
  it('a READY timeframe carries its trend, labels and the raw indicator fields of its Quant run', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bearish'), trendRun('1h', 'bullish'), trendRun('15m', 'bullish')]);
    const h1 = c.timeframes['1h']!;
    expect(h1).toMatchObject({ interval: '1h', status: 'READY', structure: { trend: 'bullish', lastHighLabel: 'HH', lastLowLabel: 'HL' } });
    expect(h1.momentum).toHaveProperty('rsi');
    expect(h1.trendStrength).toHaveProperty('adx');
    expect(h1.levels).toHaveProperty('pivots');
    expect(h1.quantRunId).toMatch(/^qr_/);
    expect(h1.quantResultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a timeframe whose data is invalid contributes no structural state and its trend is never copied into alignment', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('1h', 'bullish', { valid: false })]);
    expect(c.timeframes['1h']).toMatchObject({ status: 'INVALID_DATA', structure: { trend: 'unknown' } });
    expect(c.layers.INTRADAY.state).toBe('unavailable');
    expect(c.timeframeAlignment.state).toBe('INSUFFICIENT_CONTEXT');
    expect(c.timeframeAlignment.state).not.toBe('FULL_BULL_ALIGNMENT');
  });

  it('a valid run with too few confirmed swings is READY with an unknown trend, not invalid data', () => {
    const c = ctx([trendRun('1d', 'unknown'), trendRun('4h', 'bullish'), trendRun('1h', 'bullish')]);
    expect(c.timeframes['1d']).toMatchObject({ status: 'READY', structure: { trend: 'unknown' } });
    expect(c.layers.POSITION.state).toBe('unknown');
    expect(c.timeframeAlignment.state).toBe('INSUFFICIENT_CONTEXT');
  });

  it('a timeframe whose warm-up is not complete is INSUFFICIENT_DATA, and its structure is not read as a trend', () => {
    const c = ctx([trendRun('1d', 'bullish', { warmupReady: false }), trendRun('4h', 'bullish'), trendRun('1h', 'bullish')]);
    expect(c.timeframes['1d']).toMatchObject({ status: 'INSUFFICIENT_DATA', structure: { trend: 'unknown' } });
    expect(c.layers.POSITION.state).toBe('unavailable');
  });

  it('indicators are carried as raw values and never become a directional verdict: RSI, ADX or MACD alone change no state', () => {
    const c = ctx([trendRun('1d', 'range'), trendRun('4h', 'range'), trendRun('1h', 'range')]);
    expect(c.timeframeAlignment.state).toBe('RANGE_DOMINANT');
    expect(JSON.stringify(c)).not.toMatch(/"bias"|"score"[^S]|"vote"/);
  });
});

describe('layer states preserve each exact timeframe', () => {
  it('two intervals of one layer that disagree give mixed, and both stay visible', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('1h', 'bearish'), trendRun('15m', 'bullish')]);
    expect(c.layers.INTRADAY.state).toBe('mixed');
    expect(c.layers.INTRADAY.contributing).toEqual([
      { interval: '15m', trend: 'bullish' },
      { interval: '1h', trend: 'bearish' },
    ]);
  });

  it('a layer picks no interval silently: one usable interval gives its own state', () => {
    const c = ctx([trendRun('1d', 'bearish'), trendRun('4h', 'bearish'), trendRun('1h', 'bearish')]);
    expect(c.layers.INTRADAY.state).toBe('bearish');
    expect(c.layers.INTRADAY.contributing).toEqual([{ interval: '1h', trend: 'bearish' }]);
  });

  it('the strategic layer is unavailable in V1 and no weekly or monthly state is fabricated from daily bars', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('1h', 'bullish')]);
    expect(c.layers.STRATEGIC.state).toBe('unavailable');
    expect(c.secularTrend).toMatchObject({ status: 'unavailable' });
    expect(c.secularTrend.reason).toMatch(/weekly and monthly/);
  });

  it('the hierarchy is fixed by the brief: 1m and 5m micro, 15m and 1h intraday, 4h swing, 1d position', () => {
    expect(DEFAULT_HIERARCHY).toEqual({ MICRO: ['1m', '5m'], INTRADAY: ['15m', '1h'], SWING: ['4h'], POSITION: ['1d'], STRATEGIC: [] });
  });
});

describe('alignment and phase (alignment:v1)', () => {
  it('A. POSITION, SWING and INTRADAY all bullish: FULL_BULL_ALIGNMENT, impulse_up, dominant trend bullish from POSITION', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('1h', 'bullish'), trendRun('15m', 'bullish')]);
    expect(c.timeframeAlignment.state).toBe('FULL_BULL_ALIGNMENT');
    expect(c.currentPhase).toBe('impulse_up');
    expect(c.dominantTrend).toMatchObject({ trend: 'bullish', sourceLayer: 'POSITION' });
  });

  it('B. all bearish: FULL_BEAR_ALIGNMENT, impulse_down', () => {
    const c = ctx([trendRun('1d', 'bearish'), trendRun('4h', 'bearish'), trendRun('1h', 'bearish')], ['1h', '4h', '1d']);
    expect(c.timeframeAlignment.state).toBe('FULL_BEAR_ALIGNMENT');
    expect(c.currentPhase).toBe('impulse_down');
  });

  it('C. higher bullish, swing bearish, intraday bullish: HIGHER_BULL_LOWER_PULLBACK, pullback_in_uptrend', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bearish'), trendRun('1h', 'bullish')], ['1h', '4h', '1d']);
    expect(c.timeframeAlignment.state).toBe('HIGHER_BULL_LOWER_PULLBACK');
    expect(c.currentPhase).toBe('pullback_in_uptrend');
  });

  it('D. higher bearish, swing bullish, intraday bearish: HIGHER_BEAR_LOWER_RALLY, relief_rally_in_downtrend', () => {
    const c = ctx([trendRun('1d', 'bearish'), trendRun('4h', 'bullish'), trendRun('1h', 'bearish')], ['1h', '4h', '1d']);
    expect(c.timeframeAlignment.state).toBe('HIGHER_BEAR_LOWER_RALLY');
    expect(c.currentPhase).toBe('relief_rally_in_downtrend');
  });

  it('E. all range: RANGE_DOMINANT, range', () => {
    const c = ctx([trendRun('1d', 'range'), trendRun('4h', 'range'), trendRun('1h', 'range')], ['1h', '4h', '1d']);
    expect(c.timeframeAlignment.state).toBe('RANGE_DOMINANT');
    expect(c.currentPhase).toBe('range');
  });

  it('F. higher bullish, swing bearish, intraday mixed (1h bearish, 15m bullish): CONFLICTED, transition, with no hidden score', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bearish'), trendRun('1h', 'bearish'), trendRun('15m', 'bullish')]);
    expect(c.layers.INTRADAY.state).toBe('mixed');
    expect(c.timeframeAlignment.state).toBe('CONFLICTED');
    expect(c.currentPhase).toBe('transition');
  });

  it('the whole table, layer by layer, with every state named', () => {
    const table: Array<[LayerTrend, LayerTrend, LayerTrend, string]> = [
      ['range', 'range', 'range', 'RANGE_DOMINANT'],
      ['range', 'bullish', 'bullish', 'CONFLICTED'],
      ['bullish', 'bullish', 'range', 'HIGHER_BULL_LOWER_PULLBACK'],
      ['bullish', 'range', 'bullish', 'HIGHER_BULL_LOWER_PULLBACK'],
      ['bullish', 'bearish', 'bearish', 'CONFLICTED'],
      ['bullish', 'mixed', 'mixed', 'CONFLICTED'],
      ['bearish', 'bullish', 'range', 'HIGHER_BEAR_LOWER_RALLY'],
      ['bearish', 'bearish', 'bullish', 'HIGHER_BEAR_LOWER_RALLY'],
      ['unknown', 'bullish', 'bullish', 'INSUFFICIENT_CONTEXT'],
      ['bullish', 'unavailable', 'bullish', 'INSUFFICIENT_CONTEXT'],
    ];
    for (const [p, s, i, expected] of table) expect(alignmentOf(p, s, i), p + '/' + s + '/' + i).toBe(expected);
    expect(phaseOf('CONFLICTED')).toBe('transition');
    expect(phaseOf('INSUFFICIENT_CONTEXT')).toBe('unknown');
  });

  it('no alignment state is a trade action', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('1h', 'bullish'), trendRun('15m', 'bullish')]);
    expect(JSON.stringify(c)).not.toMatch(FORBIDDEN_ACTIONS);
  });
});

describe('dominant trend is the highest available layer, never a vote; a lower timeframe never overrides a higher one', () => {
  it('when POSITION is unknown, the first available layer (SWING) is the dominant trend', () => {
    const c = ctx([trendRun('1d', 'unknown'), trendRun('4h', 'bullish'), trendRun('1h', 'bearish')], ['1h', '4h', '1d']);
    expect(c.dominantTrend).toMatchObject({ trend: 'bullish', sourceLayer: 'SWING' });
  });

  it('an unknown structure is never read as bullish or bearish', () => {
    const c = ctx([trendRun('1d', 'unknown'), trendRun('4h', 'unknown')], ['4h', '1d']);
    expect(c.dominantTrend).toMatchObject({ trend: 'unknown', sourceLayer: null });
  });

  it('a mixed higher layer stops the search: a lower timeframe does not override it', () => {
    const policy: ChartContextPolicy = { hierarchy: { MICRO: ['1m', '5m'], INTRADAY: ['15m'], SWING: ['1h'], POSITION: ['1d', '4h'], STRATEGIC: [] } };
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bearish'), trendRun('1h', 'bullish')], ['1h', '4h', '1d'], policy);
    expect(c.layers.POSITION.state).toBe('mixed');
    expect(c.dominantTrend).toMatchObject({ trend: 'unknown', sourceLayer: 'POSITION' });
  });
});

describe('support and resistance keep their origin and are never merged', () => {
  it('higher-timeframe levels are major, lower-timeframe levels are preserved as minor, and nothing is averaged', () => {
    const c = ctx([
      quantRun({ label: 'd', interval: '1d', support: [['90', 3]], resistance: [['120', 4]] }),
      quantRun({ label: 'h4', interval: '4h', support: [['95', 2]], resistance: [['110', 2]] }),
      quantRun({ label: 'm15', interval: '15m', support: [['99', 2]] }),
    ], ['15m', '4h', '1d']);
    expect(c.majorSupport.map((l) => [l.interval, l.price])).toEqual([['1d', '90'], ['4h', '95']]);
    expect(c.minorSupport.map((l) => [l.interval, l.price])).toEqual([['15m', '99']]);
    expect(c.majorResistance.map((l) => [l.interval, l.price])).toEqual([['1d', '120'], ['4h', '110']]);
    expect(JSON.stringify(c)).not.toContain('94.67');
    expect(c.majorSupport[0]).toMatchObject({ sourceQuantRunId: expect.stringMatching(/^qr_/), sourceResultHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe('provenance and coverage are reported honestly, and no question is collapsed', () => {
  it('a historical reconstruction is carried, and decision-time knowledge stays proven', () => {
    const c = ctx([
      trendRun('1d', 'bullish', { provenance: { decisionTimeKnowledgeProven: true, historicalReconstruction: true, allBarsContemporaneousVintage: false } }),
      trendRun('4h', 'bullish'),
      trendRun('1h', 'bullish'),
    ], ['1h', '4h', '1d']);
    expect(c.provenance).toMatchObject({ decisionTimeKnowledgeProven: true, historicalReconstruction: true });
  });

  it('one interval whose knowledge is not proven makes the whole context not decision-time proven', () => {
    const c = ctx([
      trendRun('1d', 'bullish'),
      trendRun('4h', 'bullish', { provenance: { decisionTimeKnowledgeProven: false } }),
      trendRun('1h', 'bullish'),
    ], ['1h', '4h', '1d']);
    expect(c.provenance.decisionTimeKnowledgeProven).toBe(false);
    expect(c.provenance.perTimeframe['4h']).toMatchObject({ decisionTimeKnowledgeProven: false });
  });

  it('a requested interval with no run is missing: coverage is incomplete, and the higher context is still computed', () => {
    const c = ctx([trendRun('1h', 'bullish'), trendRun('4h', 'bullish'), trendRun('1d', 'bullish')], ['5m', '15m', '1h', '4h', '1d']);
    expect(c.coverage).toMatchObject({ requestedIntervals: ['5m', '15m', '1h', '4h', '1d'], missingIntervals: ['5m', '15m'], complete: false });
    expect(c.timeframeAlignment.state).toBe('FULL_BULL_ALIGNMENT');
  });

  it('coverage is complete only when every requested interval is READY; an unrequested 1m is not a gap', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('1h', 'bullish'), trendRun('15m', 'bullish')]);
    expect(c.coverage.complete).toBe(true);
    expect(c.coverage.missingIntervals).toEqual([]);
    expect(c.quality).toMatchObject({ dataValid: true, contextComplete: true });
  });

  it('an invalid interval is listed as invalid and makes the data not valid', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('1h', 'bullish', { valid: false })], ['1h', '4h', '1d']);
    expect(c.coverage).toMatchObject({ invalidIntervals: ['1h'], complete: false });
    expect(c.quality.dataValid).toBe(false);
  });
});

describe('identity, input order and isolation', () => {
  it('input order and requested-interval order do not change the context or its identity', () => {
    const a = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bearish'), trendRun('1h', 'bullish')], ['1h', '4h', '1d']);
    const b = ctx([trendRun('1h', 'bullish'), trendRun('1d', 'bullish'), trendRun('4h', 'bearish')], ['1d', '1h', '4h']);
    expect(b.chartContextId).toBe(a.chartContextId);
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b).toEqual(a);
  });

  it('changing one run changes the identity: a different quantRunId or resultHash gives a different context', () => {
    const a = ctx([trendRun('1d', 'bullish', { label: 'x' }), trendRun('1h', 'bullish')], ['1h', '1d']);
    const b = ctx([trendRun('1d', 'bullish', { label: 'y' }), trendRun('1h', 'bullish')], ['1h', '1d']);
    expect(b.chartContextId).not.toBe(a.chartContextId);
  });

  it('a different asOf changes the identity', () => {
    const a = ctx([trendRun('1d', 'bullish'), trendRun('1h', 'bullish')], ['1h', '1d']);
    const later = buildChartContext({ instrumentId: 'AAPL', asOf: '2026-10-10T00:00:00.000Z', requestedIntervals: ['1h', '1d'], runs: [quantRun({ label: 'later', interval: '1d', asOf: '2026-10-10T00:00:00.000Z' }), quantRun({ label: 'later1h', interval: '1h', asOf: '2026-10-10T00:00:00.000Z' })] });
    expect(later.chartContextId).not.toBe(a.chartContextId);
  });

  it('a changed hierarchy policy changes the identity', () => {
    const runs = [trendRun('1d', 'bullish'), trendRun('4h', 'bullish')];
    const a = ctx(runs, ['4h', '1d']);
    const b = ctx(runs, ['4h', '1d'], { hierarchy: { MICRO: ['1m', '5m'], INTRADAY: ['15m', '1h'], SWING: ['1d'], POSITION: ['4h'], STRATEGIC: [] } });
    expect(b.chartContextId).not.toBe(a.chartContextId);
  });

  it('createdAt does not enter the identity', () => {
    const a = ctx([quantRun({ label: 'c', interval: '1d', createdAt: '2026-12-31T00:00:00.000Z' }), trendRun('1h', 'bullish')], ['1h', '1d']);
    const b = ctx([quantRun({ label: 'c', interval: '1d', createdAt: '2027-06-01T00:00:00.000Z' }), trendRun('1h', 'bullish')], ['1h', '1d']);
    expect(b.chartContextId).toBe(a.chartContextId);
  });

  it('the caller objects are not mutated, and the context is frozen', () => {
    const runs = [trendRun('1d', 'bullish', { support: [['90', 3]] }), trendRun('1h', 'bullish')];
    const before = runs.map((r) => hashOf(r));
    const c = ctx(runs, ['1h', '1d']);
    expect(runs.map((r) => hashOf(r))).toEqual(before);
    expect(Object.isFrozen(c)).toBe(true);
    expect(() => {
      (c as { chartContextId: string }).chartContextId = 'forged';
    }).toThrow();
  });
});

describe('the hierarchy policy is a partition of the native intervals', () => {
  it('an interval placed in two layers, or in no layer, is refused before any run is read', () => {
    const duplicated: ChartContextPolicy = { hierarchy: { ...DEFAULT_HIERARCHY, SWING: ['4h', '1d'] } };
    expect((thrownBy(() => ctx([trendRun('1d', 'bullish')], ['1d'], duplicated)) as Error).message).toContain('CHART_POLICY_INVALID');
    const missing: ChartContextPolicy = { hierarchy: { ...DEFAULT_HIERARCHY, POSITION: [] } };
    expect((thrownBy(() => ctx([trendRun('1d', 'bullish')], ['1d'], missing)) as Error).message).toContain('1d is in no layer');
  });
});

describe('the context carries its version identities and no trade action', () => {
  it('versions are present and the context contains no action, probability or pattern claim', () => {
    const c = ctx([trendRun('1d', 'bullish'), trendRun('4h', 'bullish'), trendRun('1h', 'bullish')], ['1h', '4h', '1d']);
    expect(c).toMatchObject({ engineVersion: 'chart-context-engine:v1', hierarchyVersion: 'timeframe-hierarchy:v1', alignmentVersion: 'alignment:v1' });
    expect(JSON.stringify(c)).not.toMatch(FORBIDDEN_ACTIONS);
  });
});
