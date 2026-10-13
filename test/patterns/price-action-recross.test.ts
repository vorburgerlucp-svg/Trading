import { describe, expect, it } from 'vitest';
import { runPatternEngine, type PatternRunInput } from '../../src/patterns/pattern-engine.js';
import { asOfAfter, barsOf, INSTRUMENT_ID, SOURCE, XNAS } from './fixtures.js';
import { RECROSS_PIVOTS } from './price-action-fixtures.js';

// The gap reproduced (docs/PATTERN_ENGINE_V1B.md §25.1). A resistance is broken at bar 41. A third touch then changes the level's evidence, and a
// same-direction re-cross at bar 90 is the same structural level. This test uses only the engine API, so it runs on the V1B commit as well.

const instrument = { instrumentId: INSTRUMENT_ID, assetClass: 'stock' as const, allowsNegativePrices: false };
const run = (bars: PatternRunInput['bars'], asOf: string) =>
  runPatternEngine({ instrument, calendar: XNAS, series: { source: SOURCE, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, replay: 'decision_time' });

describe('same-direction re-cross after a later touch (docs/PATTERN_ENGINE_V1B.md §25.1, §25.5)', () => {
  const bars = barsOf(RECROSS_PIVOTS, 100);

  it('a later third touch does not turn the re-cross into a second independent resistance_breakout', () => {
    const r = run(bars, asOfAfter(bars, 99));
    expect(r.observations.filter((o) => o.patternType === 'resistance_breakout')).toHaveLength(1);
  });

  it('the breakout that remains is the first crossing, at bar 41', () => {
    const [b] = run(bars, asOfAfter(bars, 99)).observations.filter((o) => o.patternType === 'resistance_breakout');
    expect(b!.firstSeenAt).toBe(bars[41]!.retrievedAt);
  });
});
