import { runPatternEngine, type PatternRunInput } from '../../src/patterns/pattern-engine.js';
import { asOfAfter, barsOf, DESCENDING, DOUBLE_TOP, HS_TOP, INSTRUMENT_ID, mirroredPivots, scaled, SOURCE, SYMMETRICAL_DOWN, XNAS, ASCENDING } from './fixtures.js';

// The V1 golden snapshot (docs/PATTERN_ENGINE_V1B.md §20). It records only the seven V1 types, and only the fields that identify and describe
// a structure. The observation id (po_) and the run identifiers are excluded, because they include the run fingerprint, which changes with the
// explicit V1B version bump.

export const V1_TYPES = new Set([
  'head_and_shoulders',
  'inverse_head_and_shoulders',
  'double_top',
  'double_bottom',
  'ascending_triangle',
  'descending_triangle',
  'symmetrical_triangle',
]);

const instrument = { instrumentId: INSTRUMENT_ID, assetClass: 'stock' as const, allowsNegativePrices: false };

function input(bars: PatternRunInput['bars'], asOf: string): PatternRunInput {
  return { instrument, calendar: XNAS, series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, replay: 'decision_time' };
}

const upPivots: Array<[number, number]> = [[0, 105], [12, 112], [18, 100], [24, 109], [30, 103], [36, 106], [42, 104.5], [46, 116], [52, 125], [60, 125]];
const shallowPivots = DOUBLE_TOP.map(([i, p]) => (i === 20 ? [i, 109] : [i, p])) as Array<[number, number]>;

/** The fixed case list. Every case runs at several asOf values, so the snapshot covers each lifecycle state. */
export const GOLDEN_CASES: Array<{ name: string; bars: () => PatternRunInput['bars']; asOfIndices: number[] }> = [
  { name: 'head_and_shoulders', bars: () => barsOf(HS_TOP, 65), asOfIndices: [43, 45, 46, 47, 50, 56, 64] },
  { name: 'inverse_head_and_shoulders', bars: () => barsOf(mirroredPivots(HS_TOP), 65), asOfIndices: [46, 50, 56] },
  { name: 'double_top', bars: () => barsOf(DOUBLE_TOP, 60), asOfIndices: [33, 45, 52] },
  { name: 'double_bottom', bars: () => barsOf(mirroredPivots(DOUBLE_TOP), 60), asOfIndices: [45, 52] },
  { name: 'ascending_triangle', bars: () => barsOf(ASCENDING, 62), asOfIndices: [46, 47, 55, 61] },
  { name: 'descending_triangle', bars: () => barsOf(DESCENDING, 62), asOfIndices: [47, 55, 61] },
  { name: 'symmetrical_triangle_down', bars: () => barsOf(SYMMETRICAL_DOWN, 62), asOfIndices: [47, 55] },
  { name: 'symmetrical_triangle_up', bars: () => barsOf(upPivots, 62), asOfIndices: [47, 55] },
  { name: 'double_top_shallow_near_miss', bars: () => barsOf(shallowPivots, 60), asOfIndices: [45] },
  { name: 'head_and_shoulders_x10', bars: () => scaled(barsOf(HS_TOP, 65), 10), asOfIndices: [46, 56] },
];

/** The V1 part of every case's run, as plain data. */
export function v1Snapshot(): unknown[] {
  return GOLDEN_CASES.map((c) => {
    const bars = c.bars();
    return {
      case: c.name,
      runs: c.asOfIndices.map((i) => {
        const asOf = asOfAfter(bars, i);
        const run = runPatternEngine(input(bars, asOf));
        const observations = run.observations
          .filter((o) => V1_TYPES.has(o.patternType))
          .map((o) => ({
            patternInstanceId: o.patternInstanceId,
            patternType: o.patternType,
            direction: o.direction,
            status: o.status,
            firstSeenAt: o.firstSeenAt,
            confirmedAt: o.confirmedAt,
            invalidatedAt: o.invalidatedAt,
            resolvedAt: o.resolvedAt,
            anchors: o.anchors,
            confirmation: o.confirmation,
            invalidation: o.invalidation,
            target: o.target,
            boundaries: o.boundaries,
            geometryMetrics: o.geometryMetrics,
          }))
          .sort((a, b) => (a.patternInstanceId < b.patternInstanceId ? -1 : a.patternInstanceId > b.patternInstanceId ? 1 : 0));
        return { asOf, status: run.status, observations };
      }),
    };
  });
}
