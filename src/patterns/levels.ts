// The level family of the price-action structures (docs/PATTERN_ENGINE_V1B.md §3–§4, §6). Levels come from the existing support/resistance
// clustering over the existing confirmed swings. The level set at a bar uses only the swings confirmed by an earlier bar, so no later touch can
// change it.

import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { supportResistance, SUPPORT_RESISTANCE_VERSION, type SupportResistanceLevel, type SwingLevelInput } from '../quant/structure/support-resistance.js';
import { scaleAt, type SpaceSwing } from './geometry.js';
import type { PitView } from './pit-view.js';
import type { PatternParameters } from './pattern-parameters.js';

export interface LevelTouch {
  kind: 'high' | 'low';
  /** View index of the extreme. */
  index: number;
  /** View index of the bar that confirmed it. */
  confirmedIndex: number;
  price: Decimal;
  time: string;
}

export interface PatternLevel {
  kind: 'support' | 'resistance';
  priceLevel: Decimal;
  /** The touches, ordered by bar. */
  touches: LevelTouch[];
  /** View index at which the level came into existence: the confirmation of its minTouches-th touch. */
  confirmedIndex: number;
  confirmedAt: string;
}

/** The confirmed swings of the view, as support/resistance input. Sorted by index; confirmedIndex is non-decreasing in index. */
export function swingInputsOf(view: PitView, swings: readonly SpaceSwing[]): SwingLevelInput[] {
  return swings.map((s) => ({
    kind: s.kind,
    index: s.index,
    price: s.price,
    time: view.bars[s.index]!.startTime,
    confirmedIndex: s.confirmedIndex,
    confirmedAt: view.bars[s.confirmedIndex]!.instant,
  }));
}

/** First position in `values` at which `predicate` holds, for a predicate that is monotone along the array. */
function firstWhere<T>(values: readonly T[], predicate: (v: T) => boolean): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (predicate(values[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The levels as they stood at `lastIndex`: support/resistance clusters of the swings confirmed by `lastIndex` within the lookback. The tolerance is
 * the level tolerance in ATR at `lastIndex`. Deterministic, and independent of any bar after `lastIndex`.
 */
export function levelsAt(view: PitView, inputs: readonly SwingLevelInput[], lastIndex: number, params: PatternParameters, atrs: ReadonlyArray<number | null>): PatternLevel[] {
  const scale = scaleAt(view, atrs, params, lastIndex);
  if (scale === null) return [];
  const lookback = params.priceAction.levelLookbackBars;
  const from = firstWhere(inputs, (s) => s.index > lastIndex - lookback);
  const to = firstWhere(inputs, (s) => s.confirmedIndex > lastIndex);
  if (to <= from) return [];
  const window = inputs.slice(from, to);
  const levels: SupportResistanceLevel[] = supportResistance(window, {
    referencePrice: view.bars[lastIndex]!.close,
    tolerance: Decimal.from(params.tolerance.sameLevelAtrMultiple).times(scale),
    minTouches: params.priceAction.levelMinTouches,
    lookbackBars: lookback,
    lastIndex,
    priceScale: params.priceAction.levelPriceScale,
  });
  const indexByTime = new Map(view.bars.map((p) => [p.startTime, p.index]));
  const indexByInstant = new Map(view.bars.map((p) => [p.instant, p.index]));
  const swingByKey = new Map(window.map((s) => [s.time + '|' + s.kind, s]));
  return levels.map((l) => ({
    kind: l.kind,
    priceLevel: l.priceLevel,
    touches: l.touches.map((t) => {
      const swing = swingByKey.get(t.time + '|' + t.kind)!;
      return { kind: t.kind, index: indexByTime.get(t.time)!, confirmedIndex: swing.confirmedIndex, price: t.price, time: t.time };
    }),
    confirmedIndex: indexByInstant.get(l.confirmedAt)!,
    confirmedAt: l.confirmedAt,
  }));
}

/**
 * The identity of a level: its evidence, not its rounded price. Two levels at the same price with different histories have different identities. The
 * touch list is sorted canonically before hashing, so the input order never matters (docs/PATTERN_ENGINE_V1B.md §4.1).
 */
export function levelIdentityOf(level: { priceLevel: Decimal; confirmedAt: string; touches: ReadonlyArray<{ kind: 'high' | 'low'; price: Decimal; time: string }> }, interval: string): string {
  const touches = [...level.touches]
    .map((t) => [t.time, t.kind, t.price.toString()] as const)
    .sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  return 'lv_' + hashOf({ kind: 'level-identity', sr: SUPPORT_RESISTANCE_VERSION, interval, priceLevel: level.priceLevel.toString(), confirmedAt: level.confirmedAt, touches }).slice(0, 40);
}
