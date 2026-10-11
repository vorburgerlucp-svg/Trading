import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { Decimal } from '../../src/money/decimal.js';
import { mirroredPivots } from './fixtures.js';

// Synthetic exact geometry for V1B (docs/PATTERN_ENGINE_V1B.md). Each series is drawn from pivots with linear legs, as in V1. Highs and lows are the
// close ± 0.5, so a pivot at price p is a swing at p + 0.5 (high) or p − 0.5 (low). Level prices are therefore .5 values (110.5, 99.5).

/**
 * Resistance at 110.5: swing highs at 10 and 26. Support at 99.5: swing lows at 18 and 34. Breakout up at bar 41: the close is 113.5 and the close at
 * bar 40 is 109, so the close crosses the level between them. The retest zone (0.3 ATR, about 0.8) is reached first at bar 56, when the low is 110.5.
 */
export const RES_PIVOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [10, 110],
  [18, 100],
  [26, 110],
  [34, 100],
  [40, 109],
  [41, 113.5],
  [44, 116],
  [50, 120],
  [56, 111],
  [62, 114],
  [70, 114],
];

/** The same resistance, broken at bar 41 (close 111.5), then closed back below the failure boundary at bar 42 (close 109.75). */
export const FALSE_PIVOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [10, 110],
  [18, 100],
  [26, 110],
  [34, 100],
  [41, 111.5],
  [43, 108],
  [50, 104],
];

/** RES with a third touch confirmed after the breakout: a swing high at 82 with its high at 110.5. */
export const RES_LATE_TOUCH_PIVOTS: ReadonlyArray<readonly [number, number]> = [...RES_PIVOTS.slice(0, 10), [76, 104], [82, 110], [88, 104], [96, 108]];

/** Flat highs at 110.5 (swings at 10, 26, 42) and flat lows at 99.5 (swings at 18, 34, 50). Breakout up at 56 (close above 110.5 + buffer). */
export const RECT_PIVOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [10, 110],
  [18, 100],
  [26, 110],
  [34, 100],
  [42, 110],
  [50, 100],
  [58, 116],
  [64, 124],
  [72, 118],
];

/** Parallel rising channel: highs (12, 24, 36, 48) and lows (18, 30, 42, 54) on lines of slope 0.25 with width 11.5. */
export const ASC_CHANNEL_PIVOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [12, 110],
  [18, 100],
  [24, 113],
  [30, 103],
  [36, 116],
  [42, 106],
  [48, 119],
  [54, 109],
  [60, 122],
  [66, 112],
  [74, 130],
];

/**
 * Rising wedge: upper line slope 1/6 through highs (12, 24, 36), lower line slope 1/3 through lows (18, 30, 42). Converging: width 13 at bar 12,
 * 8 at bar 42. Apex at bar 90. The last swing low (42) is confirmed at bar 45, because bars 43–45 stay above it.
 */
const WEDGE_BASE: ReadonlyArray<readonly [number, number]> = [
  [0, 104],
  [12, 110],
  [18, 100],
  [24, 112],
  [30, 104],
  [36, 114],
  [42, 108],
  [44, 111],
  [46, 109.5],
];
/** Breakdown: the close at bar 47 (104) is below the lower line (about 109.2). Bar 46 (close 109.5) stays above the lower line (about 108.8). */
export const WEDGE_RISING_DOWN_PIVOTS: ReadonlyArray<readonly [number, number]> = [...WEDGE_BASE, [47, 104], [48, 96]];
/** Breakout: the close at bar 48 (120) is above the upper line plus the buffer (about 116.5). */
export const WEDGE_RISING_UP_PIVOTS: ReadonlyArray<readonly [number, number]> = [...WEDGE_BASE, [48, 120]];

/**
 * RES, then a fall to 100 at 76 (a close below the level by more than the buffer at bar 66: a support breakdown of the same lineage), a third touch at
 * 110.5 (a swing high at 82, confirmed at 85), then a same-direction re-cross: the close is 104 at 88 and 116 at 90, and 110 at 89 is below the level.
 * The first breakout is bar 41, as in RES; the re-cross is bar 90, under the enlarged evidence.
 */
export const RECROSS_PIVOTS: ReadonlyArray<readonly [number, number]> = [...RES_PIVOTS.slice(0, 11), [76, 100], [82, 110], [88, 104], [90, 116], [96, 112]];

/**
 * A resistance at 110.5 whose second touch is a LOW (role reversal): a high at 10 (110.5) and a low at 28 (110.5), which is a swing low because the
 * path rises above 111 on both sides. Then a fall to 100 and a rally that breaks it at bar 45 (close 111.8, previous close 109.67). The breakout's
 * evidence is high 1, low 1.
 */
export const MIXED_PIVOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [10, 110],
  [16, 100],
  [22, 116],
  [28, 111],
  [31, 113],
  [40, 100],
  [46, 113],
  [50, 116],
];

/**
 * A level at 110.5 that loses its first touch to a 30-bar lookback and is later rebuilt from two new touches (56 and 70). With levelLookbackBars 30
 * the lineage of 110.5 formed from touches 10 and 26 has lapsed by bar 73, so the later 110.5 level is a new, unrelated lineage.
 */
export const UNRELATED_PIVOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [10, 110],
  [18, 100],
  [26, 110],
  [34, 100],
  [44, 104],
  [50, 100],
  [56, 110],
  [64, 100],
  [70, 110],
  [78, 100],
];

/** Replaces one bar's fields. The caller keeps every OHLC invariant (low ≤ open, close; high ≥ open, close). */
export function withBar(bars: readonly MarketBar[], i: number, patch: Partial<Record<'open' | 'high' | 'low' | 'close', string>>): MarketBar[] {
  return bars.map((b, k) => {
    if (k !== i) return b;
    const next = { ...b };
    for (const [key, value] of Object.entries(patch)) (next as Record<string, unknown>)[key] = Decimal.from(value as string);
    return next;
  });
}

export { mirroredPivots };
