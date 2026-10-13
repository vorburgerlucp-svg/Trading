import { describe, expect, it } from 'vitest';
import { buildPitView } from '../../src/patterns/pit-view.js';
import { asOfAfter, barsOf, HS_TOP } from './fixtures.js';

// docs/PATTERN_ENGINE_V1B.md §23. A bar that is not final ends the usable series. The bars after it are usable-looking, but a later bar must never
// join across the hole, in either replay mode.
describe('PIT prefix regression (docs/PATTERN_ENGINE_V1B.md §23)', () => {
  const base = barsOf(HS_TOP, 12);
  // A and B (indices 0, 1) are usable. C (index 2) is not final. D and E (indices 3, 4) are usable-looking.
  const bars = base.map((b, i) => (i === 2 ? { ...b, isFinal: false } : b));
  const asOf = asOfAfter(bars, 9);

  it.each(['decision_time', 'historical_research'] as const)('%s: only the bars before the unusable bar form the view', (replay) => {
    const view = buildPitView(bars, asOf, replay);
    expect(view.bars.map((p) => p.index)).toEqual([0, 1]);
    expect(view.excluded.notFinal).toBe(1);
    expect(view.excluded.afterGap).toBe(7);
  });

  it('a bar NEXUS did not hold at asOf ends the series the same way: no later bar is joined across it', () => {
    const late = base.map((b, i) => (i === 2 ? { ...b, knowledge: { ...b.knowledge, knownAt: '2030-01-01T00:00:00.000Z', knowledgeSource: 'provider_published_at' as const } } : b));
    const view = buildPitView(late, asOf, 'decision_time');
    expect(view.bars.map((p) => p.index)).toEqual([0, 1]);
    expect(view.excluded.notHeldAtAsOf).toBe(1);
  });
});
