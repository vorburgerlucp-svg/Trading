// The level family of the price-action structures (docs/PATTERN_ENGINE_V1B.md §3–§4, §6, §25). Levels come from the existing support/resistance
// clustering over the existing confirmed swings. The level set at a bar uses only the swings confirmed by an earlier bar, so no later touch can
// change it. Two identities are kept apart: the structural lineage (stable through later touches) and the evidence (exact, changes with touches).

import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { supportResistance, SUPPORT_RESISTANCE_VERSION, type SupportResistanceLevel, type SwingLevelInput } from '../quant/structure/support-resistance.js';
import { scaleAt, type SpaceSwing } from './geometry.js';
import { LEVEL_LINEAGE_VERSION, type PatternParameters } from './pattern-parameters.js';
import type { PitView } from './pit-view.js';

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

/** A level at one bar, with its structural lineage and its evidence revision (docs/PATTERN_ENGINE_V1B.md §25.2). */
export interface FrameLevel extends PatternLevel {
  /** Stable through later touches: the same price-area structure over time. */
  levelLineageId: string;
  /** Exact evidence at this bar: every current touch, the price, the confirmation. Changes with any touch. */
  levelEvidenceId: string;
  highTouchCount: number;
  lowTouchCount: number;
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

/** The canonical key of one touch: its bar start and its side. Unique per swing. */
const touchKeyOf = (t: { time: string; kind: 'high' | 'low' }): string => t.time + '|' + t.kind;

/** The touch list in canonical order (time, then kind, then price), as text. */
function canonicalTouches(touches: ReadonlyArray<{ kind: 'high' | 'low'; price: Decimal; time: string }>): Array<[string, string, string]> {
  return touches
    .map((t) => [t.time, t.kind, t.price.toString()] as [string, string, string])
    .sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
}

/**
 * The exact evidence revision of a level: every current touch, the cluster price and the confirmation instant, under the support/resistance version.
 * This is an audit identity. Adding a touch changes it (docs/PATTERN_ENGINE_V1B.md §25.4).
 */
export function levelEvidenceIdOf(level: { priceLevel: Decimal; confirmedAt: string; touches: ReadonlyArray<{ kind: 'high' | 'low'; price: Decimal; time: string }> }, interval: string): string {
  return (
    'le_' +
    hashOf({ kind: 'level-evidence', sr: SUPPORT_RESISTANCE_VERSION, interval, priceLevel: level.priceLevel.toString(), confirmedAt: level.confirmedAt, touches: canonicalTouches(level.touches) }).slice(0, 40)
  );
}

/**
 * The structural lineage of a level, born from its minimum evidence: the birth touches (the first minTouches touches in confirmation order), the
 * birth instant and the birth price. Later touches never enter it. The policy version is hashed in (docs/PATTERN_ENGINE_V1B.md §25.3).
 */
export function levelLineageIdOf(
  birth: { instrumentId: string; interval: string; confirmedAt: string; birthPrice: Decimal; birthTouches: ReadonlyArray<{ kind: 'high' | 'low'; price: Decimal; time: string }> },
  policy: string = LEVEL_LINEAGE_VERSION,
): string {
  return (
    'll_' +
    hashOf({
      kind: 'level-lineage',
      policy,
      sr: SUPPORT_RESISTANCE_VERSION,
      instrumentId: birth.instrumentId,
      interval: birth.interval,
      confirmedAt: birth.confirmedAt,
      birthPrice: birth.birthPrice.toString(),
      birthTouches: canonicalTouches(birth.birthTouches),
    }).slice(0, 40)
  );
}

interface LineageRecord {
  id: string;
  /** Creation order: the tie-break when two lineages claim the same cluster. */
  order: number;
  birthKeys: string[];
}

/**
 * The levels of every bar, each with its lineage. The sweep runs in bar order. At each bar a cluster matches the lineage it shares a birth touch with
 * (still within the lookback); the matches are greedy and deterministic (larger overlap, then earlier birth, then lower price). A cluster that matches
 * no lineage is born as a new one. The frame at bar L depends only on bars up to L.
 */
export function buildLevelFrames(view: PitView, inputs: readonly SwingLevelInput[], params: PatternParameters, atrs: ReadonlyArray<number | null>, instrumentId: string, interval: string): FrameLevel[][] {
  const frames: FrameLevel[][] = [];
  const records = new Map<string, LineageRecord>();
  const lineagesByKey = new Map<string, string[]>();
  const minTouches = params.priceAction.levelMinTouches;
  for (let L = 0; L < view.bars.length; L++) {
    const levels = levelsAt(view, inputs, L, params, atrs);
    const keys = levels.map((lvl) => new Set(lvl.touches.map(touchKeyOf)));
    const pairs: Array<{ id: string; i: number; overlap: number }> = [];
    levels.forEach((_, i) => {
      const candidates = new Set<string>();
      for (const k of keys[i]!) for (const id of lineagesByKey.get(k) ?? []) candidates.add(id);
      for (const id of candidates) {
        const overlap = records.get(id)!.birthKeys.filter((k) => keys[i]!.has(k)).length;
        pairs.push({ id, i, overlap });
      }
    });
    pairs.sort((a, b) => b.overlap - a.overlap || records.get(a.id)!.order - records.get(b.id)!.order || a.i - b.i);
    const claimedLevel = new Map<number, string>();
    const claimedLineage = new Set<string>();
    for (const p of pairs) {
      if (claimedLevel.has(p.i) || claimedLineage.has(p.id)) continue;
      claimedLevel.set(p.i, p.id);
      claimedLineage.add(p.id);
    }
    frames.push(
      levels.map((lvl, i) => {
        let id = claimedLevel.get(i);
        if (id === undefined) {
          const birthTouches = [...lvl.touches]
            .sort((a, b) => a.confirmedIndex - b.confirmedIndex || a.index - b.index || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
            .slice(0, minTouches);
          id = levelLineageIdOf({ instrumentId, interval, confirmedAt: lvl.confirmedAt, birthPrice: lvl.priceLevel, birthTouches });
          if (!records.has(id)) {
            const birthKeys = birthTouches.map(touchKeyOf);
            records.set(id, { id, order: records.size, birthKeys });
            for (const k of birthKeys) lineagesByKey.set(k, [...(lineagesByKey.get(k) ?? []), id]);
          }
        }
        return {
          ...lvl,
          levelLineageId: id,
          levelEvidenceId: levelEvidenceIdOf(lvl, interval),
          highTouchCount: lvl.touches.filter((t) => t.kind === 'high').length,
          lowTouchCount: lvl.touches.filter((t) => t.kind === 'low').length,
        };
      }),
    );
  }
  return frames;
}
