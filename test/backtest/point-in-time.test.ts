import { describe, expect, it } from 'vitest';
import { buildBarAvailabilityQueue, PointInTimeBarState } from '../../src/backtest/point-in-time.js';
import { Decimal } from '../../src/money/decimal.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';

function bar(instrumentId: string, startTime: string, availableAt: string, close: string): MarketBar {
  const start = Date.parse(startTime);
  return {
    instrumentId,
    interval: '5m',
    startTime,
    endTime: new Date(start + 300_000).toISOString(),
    open: Decimal.from(close),
    high: Decimal.from(close),
    low: Decimal.from(close),
    close: Decimal.from(close),
    volume: Decimal.from(1000),
    source: 'fixture',
    session: 'regular',
    adjustment: 'raw',
    isFinal: true,
    observedAt: availableAt,
    availableAt,
    retrievedAt: availableAt, knowledge: { provenance: 'historical_bar_reconstruction', revisionKnownAt: null },
  };
}

describe('point-in-time availability queue', () => {
  it('does not expose a later-delivered instrument at another instrument decision time', () => {
    const a = bar('A', '2026-10-08T19:55:00.000Z', '2026-10-08T20:00:00.000Z', '100');
    const b = bar('B', '2026-10-08T19:55:00.000Z', '2026-10-08T20:00:05.000Z', '200');
    const queue = buildBarAvailabilityQueue({ A: [a], B: [b] });
    expect(queue.map((e) => e.instrumentId)).toEqual(['A', 'B']);

    const state = new PointInTimeBarState();
    state.advance(queue[0]!);
    expect(state.latest('A', '2026-10-08T20:00:00.000Z')?.close.toString()).toBe('100');
    expect(state.latest('B', '2026-10-08T20:00:00.000Z')).toBeNull();

    state.advance(queue[1]!);
    expect(state.latest('B', '2026-10-08T20:00:05.000Z')?.close.toString()).toBe('200');
  });

  it('orders events by availability rather than bar start time', () => {
    const olderButDelayed = bar('A', '2026-10-08T19:50:00.000Z', '2026-10-08T20:00:10.000Z', '99');
    const newerButEarlierAvailable = bar('B', '2026-10-08T19:55:00.000Z', '2026-10-08T20:00:00.000Z', '201');
    const queue = buildBarAvailabilityQueue({ A: [olderButDelayed], B: [newerButEarlierAvailable] });
    expect(queue.map((e) => e.instrumentId)).toEqual(['B', 'A']);
  });

  it('refuses to query beyond processed knowledge', () => {
    const state = new PointInTimeBarState();
    state.advance({ kind: 'bar', instrumentId: 'A', availableAt: '2026-10-08T20:00:00.000Z', bar: bar('A', '2026-10-08T19:55:00.000Z', '2026-10-08T20:00:00.000Z', '100') });
    expect(() => state.snapshot('2026-10-08T20:00:01.000Z')).toThrow(/beyond/);
  });
});
