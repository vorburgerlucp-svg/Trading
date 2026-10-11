import { runPatternEngine, type PatternRunInput } from '../../src/patterns/pattern-engine.js';
import { asOfAfter, barsOf, INSTRUMENT_ID, mirroredPivots, SOURCE, XNAS } from './fixtures.js';
import { ASC_CHANNEL_PIVOTS, FALSE_PIVOTS, MIXED_PIVOTS, RECROSS_PIVOTS, RECT_PIVOTS, RES_PIVOTS, WEDGE_RISING_DOWN_PIVOTS, WEDGE_RISING_UP_PIVOTS } from './price-action-fixtures.js';

// The V1B instance-id golden (docs/PATTERN_ENGINE_V1C.md §1). It records the patternInstanceId of every structure of the seven V1 types and the
// eleven V1B types, over the V1B fixtures at several asOf values. It was captured on 3bfb9ae, before any V1C change. Later V1C types are not
// recorded here, so they do not disturb it.

export const BASE_TYPES = new Set([
  'head_and_shoulders',
  'inverse_head_and_shoulders',
  'double_top',
  'double_bottom',
  'ascending_triangle',
  'descending_triangle',
  'symmetrical_triangle',
  'resistance_breakout',
  'support_breakdown',
  'breakout_retest',
  'breakdown_retest',
  'false_breakout',
  'false_breakdown',
  'rectangle',
  'ascending_channel',
  'descending_channel',
  'rising_wedge',
  'falling_wedge',
]);

const instrument = { instrumentId: INSTRUMENT_ID, assetClass: 'stock' as const, allowsNegativePrices: false };
const input = (bars: PatternRunInput['bars'], asOf: string): PatternRunInput => ({
  instrument,
  calendar: XNAS,
  series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' },
  bars,
  asOf,
  replay: 'decision_time',
});

export const ID_CASES: Array<{ name: string; bars: () => PatternRunInput['bars']; asOfIndices: number[] }> = [
  { name: 'resistance', bars: () => barsOf(RES_PIVOTS, 75), asOfIndices: [41, 56, 70] },
  { name: 'false', bars: () => barsOf(FALSE_PIVOTS, 60), asOfIndices: [42] },
  { name: 'recross', bars: () => barsOf(RECROSS_PIVOTS, 100), asOfIndices: [99] },
  { name: 'mixed', bars: () => barsOf(MIXED_PIVOTS, 60), asOfIndices: [45] },
  { name: 'rectangle', bars: () => barsOf(RECT_PIVOTS, 75), asOfIndices: [37, 56, 62] },
  { name: 'channel', bars: () => barsOf(ASC_CHANNEL_PIVOTS, 80), asOfIndices: [51, 73] },
  { name: 'wedge_down', bars: () => barsOf(WEDGE_RISING_DOWN_PIVOTS, 60), asOfIndices: [45, 47] },
  { name: 'wedge_up', bars: () => barsOf(WEDGE_RISING_UP_PIVOTS, 60), asOfIndices: [48] },
  { name: 'resistance_mirror', bars: () => barsOf(mirroredPivots(RES_PIVOTS), 75), asOfIndices: [41, 56] },
  { name: 'false_mirror', bars: () => barsOf(mirroredPivots(FALSE_PIVOTS), 60), asOfIndices: [42] },
];

/** The instance ids of the base types, per case and asOf, as sorted `type id` text. */
export function v1bIdSnapshot(): unknown[] {
  return ID_CASES.map((c) => {
    const bars = c.bars();
    return {
      case: c.name,
      runs: c.asOfIndices.map((i) => {
        const run = runPatternEngine(input(bars, asOfAfter(bars, i)));
        const ids = run.observations
          .filter((o) => BASE_TYPES.has(o.patternType))
          .map((o) => o.patternType + ' ' + o.patternInstanceId)
          .sort();
        return { asOfIndex: i, ids };
      }),
    };
  });
}
