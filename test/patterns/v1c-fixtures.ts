import type { MarketBar } from '../../src/market-data/market-data-types.js';
import { dailyBars, type Ohlcv } from '../market-data/fixtures.js';
import { CONTINUOUS_24X7 } from '../../src/market-data/sessions.js';
import { captured, FIRST_DATE, INSTRUMENT_ID, SOURCE, XNAS } from './fixtures.js';

// Synthetic OHLC for V1C (docs/PATTERN_ENGINE_V1C.md §22). A candle fixture is a background of 20 bars that sets the prior context, then the candle
// or candle group at indices 20, 21, 22. Background bars are never a pattern: their body is half their range. Every OHLC row is written out, so
// each expected candle is exact. Background step 1 gives ATR 2 exactly: the true range of each bar is 2 and the true range against the previous
// close is 2 as well.

const f = (x: number) => x.toFixed(2);

export function row(open: number, high: number, low: number, close: number): Ohlcv {
  return { open: f(open), high: f(high), low: f(low), close: f(close), volume: '1000' };
}

/** `n` background bars: closes start, start + step, …; each opens at the previous close. Falling for step −1, rising for +1. */
export function background(n: number, start: number, step: number): Ohlcv[] {
  const out: Ohlcv[] = [];
  for (let i = 0; i < n; i++) {
    const close = start + step * i;
    // The first bar opens at the virtual previous close, so it has a body (a doji would be a pattern of its own).
    const open = i === 0 ? start - step : start + step * (i - 1);
    out.push(row(open, Math.max(open, close) + 0.5, Math.min(open, close) - 0.5, close));
  }
  return out;
}

/** A series of bars from OHLC rows, built with the repository's own daily builder and captured knowledge (as barsOf). */
export function barsFromRows(rows: readonly Ohlcv[]): MarketBar[] {
  return captured(dailyBars(XNAS, FIRST_DATE, rows, { source: SOURCE, instrument: { instrumentId: INSTRUMENT_ID } }));
}

/** The falling background ends at close 81 (bar 19); the rising background also ends at close 81. */
export const FALL = (): Ohlcv[] => background(20, 100, -1);
export const RISE = (): Ohlcv[] => background(20, 62, 1);

export interface CandleCase {
  name: string;
  background: 'fall' | 'rise';
  candles: Ohlcv[];
  /** Every candle observation expected in the run, as type and absolute bar indices. */
  expect: Array<{ type: string; indices: number[] }>;
}

export const CANDLE_CASES: CandleCase[] = [
  // Single candles. The hammer shape: body 1.2 of range 6.4, lower wick 5.0, upper wick 0.2.
  { name: 'hammer', background: 'fall', candles: [row(81.1, 82.5, 76.1, 82.3)], expect: [{ type: 'hammer', indices: [20] }] },
  { name: 'hanging_man', background: 'rise', candles: [row(81.1, 82.5, 76.1, 82.3)], expect: [{ type: 'hanging_man', indices: [20] }] },
  // The inverted-hammer shape: body 1.2 of range 6.1, upper wick 4.7, lower wick 0.2.
  { name: 'inverted_hammer', background: 'fall', candles: [row(81.1, 87.0, 80.9, 82.3)], expect: [{ type: 'inverted_hammer', indices: [20] }] },
  { name: 'shooting_star', background: 'rise', candles: [row(81.1, 87.0, 80.9, 82.3)], expect: [{ type: 'shooting_star', indices: [20] }] },
  // Doji family: the generic doji has neither long wick; dragonfly and gravestone have one long wick each.
  { name: 'doji', background: 'fall', candles: [row(82.0, 84.0, 80.0, 82.1)], expect: [{ type: 'doji', indices: [20] }] },
  { name: 'dragonfly_doji', background: 'fall', candles: [row(82.0, 82.2, 78.0, 82.1)], expect: [{ type: 'dragonfly_doji', indices: [20] }] },
  { name: 'gravestone_doji', background: 'fall', candles: [row(82.0, 86.0, 81.8, 81.9)], expect: [{ type: 'gravestone_doji', indices: [20] }] },
  // Two-candle bodies.
  {
    name: 'bullish_engulfing',
    background: 'fall',
    candles: [row(90.0, 90.5, 87.5, 88.0), row(87.5, 91.5, 87.0, 91.0)],
    expect: [{ type: 'bullish_engulfing', indices: [20, 21] }],
  },
  {
    name: 'bearish_engulfing',
    background: 'fall',
    candles: [row(88.0, 90.5, 87.5, 90.0), row(90.5, 91.0, 86.5, 87.0)],
    expect: [{ type: 'bearish_engulfing', indices: [20, 21] }],
  },
  {
    name: 'bullish_harami',
    background: 'fall',
    candles: [row(90.0, 90.5, 83.5, 84.0), row(86.0, 88.5, 85.5, 88.0)],
    expect: [{ type: 'bullish_harami', indices: [20, 21] }],
  },
  {
    name: 'bearish_harami',
    background: 'fall',
    candles: [row(84.0, 90.5, 83.5, 90.0), row(88.0, 88.5, 85.5, 86.0)],
    expect: [{ type: 'bearish_harami', indices: [20, 21] }],
  },
  {
    name: 'piercing_line',
    background: 'fall',
    candles: [row(90.0, 90.5, 83.5, 84.0), row(82.0, 87.5, 81.5, 87.0)],
    expect: [{ type: 'piercing_line', indices: [20, 21] }],
  },
  {
    name: 'dark_cloud_cover',
    background: 'fall',
    candles: [row(84.0, 90.5, 83.5, 90.0), row(92.0, 92.5, 86.5, 87.0)],
    expect: [{ type: 'dark_cloud_cover', indices: [20, 21] }],
  },
  // Tweezers: the context requirement is part of the case (rising for a top, falling for a bottom).
  {
    name: 'tweezer_top',
    background: 'rise',
    candles: [row(81.0, 85.0, 80.5, 84.0), row(84.5, 85.0, 81.5, 83.0)],
    expect: [{ type: 'tweezer_top', indices: [20, 21] }],
  },
  {
    name: 'tweezer_bottom',
    background: 'fall',
    candles: [row(81.0, 81.5, 77.0, 78.0), row(77.5, 79.5, 77.0, 79.0)],
    expect: [{ type: 'tweezer_bottom', indices: [20, 21] }],
  },
  // Three-candle groups.
  {
    name: 'morning_star',
    background: 'fall',
    candles: [row(100.0, 100.5, 91.5, 92.0), row(91.0, 92.0, 89.0, 91.5), row(91.8, 97.5, 91.5, 97.0)],
    expect: [{ type: 'morning_star', indices: [20, 21, 22] }],
  },
  {
    name: 'evening_star',
    background: 'fall',
    candles: [row(92.0, 100.5, 91.5, 100.0), row(101.0, 102.0, 100.3, 101.5), row(100.5, 101.0, 94.5, 95.0)],
    expect: [{ type: 'evening_star', indices: [20, 21, 22] }],
  },
  {
    name: 'three_white_soldiers',
    background: 'fall',
    candles: [row(100.0, 104.5, 99.8, 104.0), row(102.0, 108.2, 101.8, 108.0), row(106.0, 112.3, 105.7, 112.0)],
    expect: [{ type: 'three_white_soldiers', indices: [20, 21, 22] }],
  },
  {
    name: 'three_black_crows',
    background: 'fall',
    candles: [row(104.0, 104.2, 99.5, 100.0), row(102.0, 102.2, 95.8, 96.0), row(98.0, 98.3, 91.7, 92.0)],
    expect: [{ type: 'three_black_crows', indices: [20, 21, 22] }],
  },
];

/** The strict-gap fixture: candle 2 entirely below the first body and candle 3 opening above candle 2's high. */
export const STRICT_MORNING: Ohlcv[] = [row(100.0, 100.5, 91.5, 92.0), row(91.0, 91.9, 89.0, 91.5), row(92.5, 97.5, 92.0, 97.0)];

/** The same rows on the continuous 24x7 calendar: the bars of a crypto series, with no session gaps. */
export function barsOnContinuous(rows: readonly Ohlcv[]): MarketBar[] {
  return captured(dailyBars(CONTINUOUS_24X7, FIRST_DATE, rows, { source: SOURCE, session: 'continuous', instrument: { instrumentId: INSTRUMENT_ID } }));
}
