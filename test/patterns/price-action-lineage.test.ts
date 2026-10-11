import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/money/decimal.js';
import { buildLevelFrames, levelEvidenceIdOf, levelLineageIdOf, swingInputsOf, type FrameLevel } from '../../src/patterns/levels.js';
import { atrSeriesOf, spaceOf, swingsOf } from '../../src/patterns/geometry.js';
import { runPatternEngine, type PatternRunInput } from '../../src/patterns/pattern-engine.js';
import { buildPitView } from '../../src/patterns/pit-view.js';
import { resolvePatternParameters, type PatternParameterOverrides } from '../../src/patterns/pattern-parameters.js';
import { asOfAfter, barsOf, INSTRUMENT_ID, mirroredPivots, SOURCE, XNAS } from './fixtures.js';
import { FALSE_PIVOTS, MIXED_PIVOTS, RECROSS_PIVOTS, RECT_PIVOTS, RES_PIVOTS, UNRELATED_PIVOTS } from './price-action-fixtures.js';

// docs/PATTERN_ENGINE_V1B.md §25. Lineage (structural) and evidence (audit) are separate; the breakout binds to the lineage; retest and false break
// are related members of one event family, each with an explicit parent and root.

const instrument = { instrumentId: INSTRUMENT_ID, assetClass: 'stock' as const, allowsNegativePrices: false };
function input(bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}): PatternRunInput {
  return { instrument, calendar: XNAS, series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, replay: 'decision_time', ...extra };
}
const run = (bars: PatternRunInput['bars'], asOf: string, extra: Partial<PatternRunInput> = {}) => runPatternEngine(input(bars, asOf, extra));
const ofType = (r: ReturnType<typeof run>, type: string) => r.observations.filter((o) => o.patternType === type);

/** The level frames of a whole series: one list of levels for every view index, computed as the engine computes them. */
function framesOf(bars: PatternRunInput['bars'], overrides: PatternParameterOverrides = {}): FrameLevel[][] {
  const params = resolvePatternParameters(overrides);
  const view = buildPitView(bars, asOfAfter(bars, bars.length - 1), 'decision_time');
  const swings = swingsOf(spaceOf(view, false), params.swing.leftBars, params.swing.rightBars);
  const atrs = atrSeriesOf(view, params.tolerance.atrPeriod);
  return buildLevelFrames(view, swingInputsOf(view, swings), params, atrs, INSTRUMENT_ID, '1d');
}
/** The level at `price` in the frame of bar L, or undefined. */
const levelAt = (frames: FrameLevel[][], L: number, price: number): FrameLevel | undefined => frames[L]!.find((l) => Number(l.priceLevel.toString()) === price);

describe('A/B: stable lineage, changing evidence (§25.2–§25.4)', () => {
  const bars = barsOf(RECROSS_PIVOTS, 100);
  const frames = framesOf(bars);

  it('A: two touches establish the level; its lineage and evidence are both recorded, with two touches', () => {
    const l = levelAt(frames, 40, 110.5)!;
    expect(l).toBeDefined();
    expect(l.touches).toHaveLength(2);
    expect(l.levelLineageId).toMatch(/^ll_/);
    expect(l.levelEvidenceId).toMatch(/^le_/);
  });

  it('B: the later touches keep the lineage but change the evidence; the bar-56 low is a role-reversal touch and is counted, not hidden', () => {
    const before = levelAt(frames, 40, 110.5)!;
    const after = levelAt(frames, 89, 110.5)!;
    // Touches at 10 and 26 (highs), the low at 56 (confirmed 59, a swing low at 110.5 after the breakout), and the high at 82 (confirmed 85).
    expect(after.touches).toHaveLength(4);
    expect(after.highTouchCount).toBe(3);
    expect(after.lowTouchCount).toBe(1);
    expect(after.levelLineageId).toBe(before.levelLineageId);
    expect(after.levelEvidenceId).not.toBe(before.levelEvidenceId);
  });
});

describe('C: same-direction re-cross after a third touch (§25.5)', () => {
  it('emits one resistance_breakout for the lineage, whose evidence is the two-touch evidence used at the first crossing', () => {
    const bars = barsOf(RECROSS_PIVOTS, 100);
    const [b] = ofType(run(bars, asOfAfter(bars, 99)), 'resistance_breakout');
    expect(ofType(run(bars, asOfAfter(bars, 99)), 'resistance_breakout')).toHaveLength(1);
    expect(b!.levelEvidence).toMatchObject({ touchCount: 2, highTouchCount: 2, lowTouchCount: 0 });
  });
});

describe('D: an unrelated later structure at the same price is a different lineage (§25.3)', () => {
  it('a 110.5 level rebuilt from new touches after the first lineage lapsed has a different lineage', () => {
    const bars = barsOf(UNRELATED_PIVOTS, 85);
    const frames = framesOf(bars, { priceAction: { levelLookbackBars: 30 } });
    const first = levelAt(frames, 30, 110.5)!;
    const later = levelAt(frames, 73, 110.5)!;
    expect(first).toBeDefined();
    expect(later).toBeDefined();
    expect(later.levelLineageId).not.toBe(first.levelLineageId);
    expect(later.touches.map((t) => t.index)).toEqual([56, 70]);
  });
});

describe('E/F/G/H: explicit event relationships (§25.6)', () => {
  it('E: a standalone breakout is its own root, with no parent', () => {
    const bars = barsOf(RES_PIVOTS, 75);
    const [b] = ofType(run(bars, asOfAfter(bars, 41)), 'resistance_breakout');
    expect(b!.patternLineage).toMatchObject({ parentPatternInstanceId: null, rootPatternInstanceId: b!.patternInstanceId, relationship: 'root' });
  });

  it('F: a retest is retest_of its breakout, with the breakout as root, and shares the breakout event family', () => {
    const bars = barsOf(RES_PIVOTS, 75);
    const r = run(bars, asOfAfter(bars, 70));
    const [b] = ofType(r, 'resistance_breakout');
    const [rt] = ofType(r, 'breakout_retest');
    expect(rt!.patternLineage).toMatchObject({ parentPatternInstanceId: b!.patternInstanceId, rootPatternInstanceId: b!.patternInstanceId, relationship: 'retest_of' });
    expect(rt!.patternLineage!.eventFamilyId).toBe(b!.patternLineage!.eventFamilyId);
  });

  it('G: a false break is false_break_of its breakout, with the breakout as root, and shares the breakout event family', () => {
    const bars = barsOf(FALSE_PIVOTS, 60);
    const r = run(bars, asOfAfter(bars, 42));
    const [b] = ofType(r, 'resistance_breakout');
    const [f] = ofType(r, 'false_breakout');
    expect(f!.patternLineage).toMatchObject({ parentPatternInstanceId: b!.patternInstanceId, rootPatternInstanceId: b!.patternInstanceId, relationship: 'false_break_of' });
    expect(f!.patternLineage!.eventFamilyId).toBe(b!.patternLineage!.eventFamilyId);
  });

  it('H: the support breakdown mirror has the same relations: root, retest_of, false_break_of', () => {
    const down = barsOf(mirroredPivots(RES_PIVOTS), 75);
    const r = run(down, asOfAfter(down, 56));
    const [b] = ofType(r, 'support_breakdown');
    const [rt] = ofType(r, 'breakdown_retest');
    expect(b!.patternLineage).toMatchObject({ parentPatternInstanceId: null, relationship: 'root' });
    expect(rt!.patternLineage).toMatchObject({ parentPatternInstanceId: b!.patternInstanceId, rootPatternInstanceId: b!.patternInstanceId, relationship: 'retest_of' });
    const falseDown = barsOf(mirroredPivots(FALSE_PIVOTS), 60);
    const r2 = run(falseDown, asOfAfter(falseDown, 42));
    const [b2] = ofType(r2, 'support_breakdown');
    const [f2] = ofType(r2, 'false_breakdown');
    expect(f2!.patternLineage).toMatchObject({ parentPatternInstanceId: b2!.patternInstanceId, relationship: 'false_break_of' });
  });
});

describe('event family identity (§25.6, §25.7)', () => {
  it('within every run, each family has one root and one root relationship, so related members are not counted as independent', () => {
    const bars = barsOf(RES_PIVOTS, 75);
    for (const asOf of [41, 56, 70]) {
      const families = new Map<string, { roots: Set<string>; rootRelations: number; members: number }>();
      for (const o of run(bars, asOfAfter(bars, asOf)).observations) {
        if (!o.patternLineage) continue;
        const f = families.get(o.patternLineage.eventFamilyId) ?? { roots: new Set<string>(), rootRelations: 0, members: 0 };
        f.roots.add(o.patternLineage.rootPatternInstanceId);
        f.members++;
        if (o.patternLineage.relationship === 'root') f.rootRelations++;
        families.set(o.patternLineage.eventFamilyId, f);
      }
      expect(families.size).toBe(1);
      for (const f of families.values()) {
        expect(f.roots.size).toBe(1);
        expect(f.rootRelations).toBe(1);
      }
    }
  });

  it('a re-cross of the same lineage in the other direction is a separate family (it is a different event)', () => {
    const bars = barsOf(RECROSS_PIVOTS, 100);
    const r = run(bars, asOfAfter(bars, 99));
    const [up] = ofType(r, 'resistance_breakout');
    const [down] = ofType(r, 'support_breakdown');
    expect(down!.patternLineage!.eventFamilyId).not.toBe(up!.patternLineage!.eventFamilyId);
  });
});

describe('I: mixed high and low touches are audited, not hidden (§25.8)', () => {
  it('a breakout whose level has one high and one low touch records both counts', () => {
    const bars = barsOf(MIXED_PIVOTS, 60);
    const [b] = ofType(run(bars, asOfAfter(bars, 45)), 'resistance_breakout');
    expect(b!.levelEvidence).toMatchObject({ touchCount: 2, highTouchCount: 1, lowTouchCount: 1 });
    expect(Number(b!.confirmation.level)).toBe(110.5);
  });
});

describe('role switch and lineage survival (§25.3, §13 of the brief)', () => {
  it('after a breakout the level is a support, but its lineage and the resistance lineage are the same', () => {
    const bars = barsOf(RES_PIVOTS, 75);
    const frames = framesOf(bars);
    const before = levelAt(frames, 40, 110.5)!;
    const after = levelAt(frames, 60, 110.5)!;
    expect(before.kind).toBe('resistance');
    expect(after.kind).toBe('support');
    expect(after.levelLineageId).toBe(before.levelLineageId);
  });
});

describe('J: rectangle with a later touch on one side (§25.9)', () => {
  it('the rectangle is not reborn, and its lineage metrics do not change when the evidence changes', () => {
    const bars = barsOf(RECT_PIVOTS, 75);
    const pick = (asOf: number) => ofType(run(bars, asOfAfter(bars, asOf)), 'rectangle').filter((o) => o.firstSeenAt === bars[37]!.retrievedAt);
    const early = pick(37);
    const later = pick(56);
    expect(later).toHaveLength(1);
    expect(later[0]!.geometryMetrics.upperLineageId).toBeDefined();
    expect(later[0]!.geometryMetrics.lowerLineageId).toBeDefined();
    expect(later[0]!.geometryMetrics.upperLineageId).toBe(early[0]!.geometryMetrics.upperLineageId);
    expect(later[0]!.geometryMetrics.lowerLineageId).toBe(early[0]!.geometryMetrics.lowerLineageId);
    expect(later[0]!.patternInstanceId).toBe(early[0]!.patternInstanceId);
  });
});

describe('K: the lineage policy is in the fingerprint (§25.10)', () => {
  it('the run carries the level-lineage version, and the lineage id depends on the policy string', () => {
    const bars = barsOf(RES_PIVOTS, 75);
    expect(run(bars, asOfAfter(bars, 41)).levelLineageVersion).toBe('level-lineage:v1');
    const birth = { instrumentId: INSTRUMENT_ID, interval: '1d', confirmedAt: bars[29]!.retrievedAt, birthPrice: Decimal.from('110.5'), birthTouches: [{ time: bars[10]!.startTime, kind: 'high' as const, price: Decimal.from('110.5') }, { time: bars[26]!.startTime, kind: 'high' as const, price: Decimal.from('110.5') }] };
    expect(levelLineageIdOf(birth, 'level-lineage:v1')).not.toBe(levelLineageIdOf(birth, 'level-lineage:v2'));
  });

  it('the evidence id is an audit hash: two evidence sets at the same price differ, and touch order does not matter', () => {
    const touch = (time: string, kind: 'high' | 'low') => ({ kind, price: Decimal.from('110.5'), time });
    const a = { priceLevel: Decimal.from('110.5'), confirmedAt: '2026-02-03T21:01:00.000Z', touches: [touch('2026-01-20T00:00:00.000Z', 'high'), touch('2026-02-02T00:00:00.000Z', 'high')] };
    const reversed = { ...a, touches: [...a.touches].reverse() };
    expect(levelEvidenceIdOf(a, '1d')).toBe(levelEvidenceIdOf(reversed, '1d'));
    const more = { ...a, touches: [...a.touches, touch('2026-02-10T00:00:00.000Z', 'low')] };
    expect(levelEvidenceIdOf(more, '1d')).not.toBe(levelEvidenceIdOf(a, '1d'));
  });
});

describe('breakout identity binds to the lineage, not to the evidence (§25.5)', () => {
  it('the breakout instance id does not change when a third touch changes the evidence', () => {
    const bars = barsOf(RECROSS_PIVOTS, 100);
    const early = ofType(run(bars, asOfAfter(bars, 41)), 'resistance_breakout')[0]!;
    const later = ofType(run(bars, asOfAfter(bars, 99)), 'resistance_breakout')[0]!;
    expect(later.patternInstanceId).toBe(early.patternInstanceId);
    expect(later.levelEvidence!.levelEvidenceId).toBe(early.levelEvidence!.levelEvidenceId);
  });
});
