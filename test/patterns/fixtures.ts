import { getCalendar } from '../../src/market-data/sessions.js';
import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { parseUtc, toUtcIso } from '../../src/market-data/time.js';
import { PRODUCTION_LIKE_SOURCE, dailyBars, type Ohlcv } from '../market-data/fixtures.js';

// Synthetic exact geometry for the pattern tests. A series is drawn from pivots (bar index, price) with linear legs between them, so every
// pivot is an exact swing and the geometry is known in advance. Bars are built by the repo's own daily bar builder on the XNAS calendar, with
// captured knowledge (retrieved one minute after completion), so they pass the same data-quality rules as production bars.

export const XNAS = getCalendar('XNAS')!;
export const INSTRUMENT_ID = 'AAPL';
export const SOURCE = PRODUCTION_LIKE_SOURCE.sourceId;
export const FIRST_DATE = '2026-01-05';
export const HALF_RANGE = 0.5;

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Prices of the path at every bar index: linear legs between the pivots, constant before the first and after the last. */
export function pathOf(pivots: ReadonlyArray<readonly [number, number]>, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i <= pivots[0]![0]) {
      out.push(pivots[0]![1]);
      continue;
    }
    const last = pivots[pivots.length - 1]!;
    if (i >= last[0]) {
      out.push(last[1]);
      continue;
    }
    let k = 0;
    while (pivots[k + 1]![0] < i) k++;
    const [i0, p0] = pivots[k]!;
    const [i1, p1] = pivots[k + 1]!;
    out.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
  }
  return out;
}

/** Final captured daily bars for the path. high/low extend the close and the previous close, so every bar is internally valid. */
export function barsOf(pivots: ReadonlyArray<readonly [number, number]>, n: number, opts: { halfRange?: number; scale?: number; instrumentId?: string } = {}): MarketBar[] {
  const h = opts.halfRange ?? HALF_RANGE;
  const scale = opts.scale ?? 1;
  const p = pathOf(pivots, n).map((x) => x * scale);
  const rows: Ohlcv[] = p.map((close, i) => {
    const prev = i === 0 ? close : p[i - 1]!;
    const open = prev;
    return {
      open: round2(open).toFixed(2),
      high: round2(Math.max(open, close) + h * scale).toFixed(2),
      low: round2(Math.min(open, close) - h * scale).toFixed(2),
      close: round2(close).toFixed(2),
      volume: '1000',
    };
  });
  return captured(dailyBars(XNAS, FIRST_DATE, rows, { source: SOURCE, instrument: { instrumentId: opts.instrumentId ?? INSTRUMENT_ID } }));
}

/** Captured knowledge: NEXUS retrieved each bar one minute after it completed. */
export function captured(bars: MarketBar[]): MarketBar[] {
  return bars.map((b) => {
    const at = toUtcIso(parseUtc(b.observedAt) + 60_000);
    return { ...b, retrievedAt: at, knowledge: { knownAt: at, knowledgeSource: 'captured_by_nexus' as const, vintage: 'contemporaneous' as const, vintagePolicy: 'bar-vintage:v1' } };
  });
}

/** The as-of instant just after bar i became available: the first instant NEXUS could hold that bar. */
export function asOfAfter(bars: readonly MarketBar[], i: number): string {
  return toUtcIso(parseUtc(bars[i]!.availableAt) + 60_000);
}

/** Bars with the same prices and the same structure, every price multiplied by k. */
export function scaled(bars: readonly MarketBar[], k: number): MarketBar[] {
  const mul = (d: MarketBar['close']) => d.times(k);
  return bars.map((b) => ({ ...b, open: mul(b.open), high: mul(b.high), low: mul(b.low), close: mul(b.close) }));
}

/** A head and shoulders top. Pivots: H1 (10,110), L1 (18,100), H2 (26,120), L2 (34,101), H3 (42,111); then a breakdown and a fall to the target. */
export const HS_TOP: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [10, 110],
  [18, 100],
  [26, 120],
  [34, 101],
  [42, 111],
  [48, 92],
  [56, 80],
  [64, 80],
];

/** A double top: H1 (10,110), L1 (20,100), H2 (30,110.5), then a breakdown and a fall through the target. */
export const DOUBLE_TOP: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [10, 110],
  [20, 100],
  [30, 110.5],
  [36, 95],
  [44, 85],
  [52, 85],
];

/** An ascending triangle: flat resistance near 110, rising support, then an upward breakout and a rise. */
export const ASCENDING: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [12, 110],
  [18, 101],
  [24, 110],
  [30, 104],
  [36, 110],
  [42, 106],
  [46, 114],
  [52, 125],
  [60, 125],
];

/** A descending triangle: flat support near 100, falling resistance, then a downward breakdown. */
export const DESCENDING: ReadonlyArray<readonly [number, number]> = [
  [0, 110],
  [12, 100],
  [18, 109],
  [24, 100],
  [30, 106],
  [36, 100],
  [42, 104],
  [46, 96],
  [52, 85],
  [60, 85],
];

/** A symmetrical triangle: falling highs, rising lows; a downward breakout. */
export const SYMMETRICAL_DOWN: ReadonlyArray<readonly [number, number]> = [
  [0, 105],
  [12, 112],
  [18, 100],
  [24, 109],
  [30, 103],
  [36, 106],
  [42, 104.5],
  [46, 96],
  [52, 85],
  [60, 85],
];

/** The same bars mirrored around 200: every high becomes the negated low, so a top pattern becomes its bottom mirror. */
export function mirroredPivots(pivots: ReadonlyArray<readonly [number, number]>, centre = 200): Array<[number, number]> {
  return pivots.map(([i, p]) => [i, centre - p] as [number, number]);
}
