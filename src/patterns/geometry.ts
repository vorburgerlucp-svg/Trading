// Deterministic pattern geometry (pattern-geometry:v1). Every condition is evaluated in units of the scale A (Wilder ATR or a configured
// percentage) with exact Decimal arithmetic. Candidates come only from consecutive alternating confirmed swings, so the search is bounded.
// Bottoms are the mirror of tops: the same detector runs on a mirrored space, where each high is the negated low (docs/PATTERN_ENGINE_V1.md §8).

import { atr } from '../quant/indicators/atr.js';
import { findSwings } from '../quant/structure/swings.js';
import { Decimal } from '../money/decimal.js';
import { apexOf, horizontal, leastSquares, lineThrough, maxResidual, valueAt, type Line, type Touch } from './line.js';
import type { PatternParameters } from './pattern-parameters.js';
import type { PatternType } from './pattern-types.js';
import type { PitView } from './pit-view.js';

/** One orientation of the view: the real prices, or the mirrored prices (high = −low, low = −high, close = −close). */
export interface Space {
  high: Decimal[];
  low: Decimal[];
  close: Decimal[];
}

export interface SpaceSwing {
  kind: 'high' | 'low';
  index: number;
  price: Decimal;
  confirmedIndex: number;
}

export interface Anchor {
  role: string;
  kind: 'high' | 'low';
  price: Decimal;
  index: number;
  confirmedIndex: number;
}

export type Boundary = 'breakUp' | 'breakDown' | 'invalidateUp' | 'invalidateDown' | 'failUpAfterDown' | 'failDownAfterUp';

export interface Candidate {
  patternType: PatternType;
  /** True when the candidate lives in the mirrored space; its prices are negated back on output. */
  mirrored: boolean;
  anchors: Anchor[];
  /** The view index at which the geometry became known: the confirming bar of its last anchor. */
  geometryKnownIndex: number;
  /** The scale unit A. */
  scale: Decimal;
  /** Boundary lines in the candidate's space. */
  boundaries: Partial<Record<Boundary, Line>>;
  /** The technical target in the candidate's space, for a confirmation in the given space direction. */
  targetAt: (direction: 'up' | 'down', confirmIndex: number) => Decimal;
  targetMethod: string;
  invalidationRule: string;
  /** The level that invalidates before confirmation, for the observation (candidate space). */
  invalidationLevel: Decimal;
  confirmationWindowBars: number;
  breakoutBuffer: Decimal;
  failureBuffer: Decimal;
  targetTolerance: Decimal;
  maxOutcomeBars: number;
  /** The direction of the pattern in the original price space (neutral while a symmetrical triangle forms). */
  direction: 'bullish' | 'bearish' | 'neutral';
  metrics: Record<string, string>;
  /** Lines for the observation, in the candidate's space. */
  lines: Record<string, Line>;
}

export interface Diagnostics {
  swings: number;
  candidates: number;
  rejectedNoScale: number;
}

/** The space of the view for one orientation. */
export function spaceOf(view: PitView, mirrored: boolean): Space {
  const high = view.bars.map((p) => (mirrored ? p.low.negated() : p.high));
  const low = view.bars.map((p) => (mirrored ? p.high.negated() : p.low));
  const close = view.bars.map((p) => (mirrored ? p.close.negated() : p.close));
  return { high, low, close };
}

/** Confirmed swings of a space, in index order. Uses the existing swing algorithm. */
export function swingsOf(space: Space, leftBars: number, rightBars: number): SpaceSwing[] {
  const raw = findSwings(
    space.high.map((d) => Number(d.toString())),
    space.low.map((d) => Number(d.toString())),
    leftBars,
    rightBars,
  );
  return raw.map((s) => ({ kind: s.kind, index: s.index, price: s.kind === 'high' ? space.high[s.index]! : space.low[s.index]!, confirmedIndex: s.confirmedIndex }));
}

/** Wilder ATR of the original view (the mirror has the same true range, so one series serves both spaces). */
export function atrSeriesOf(view: PitView, period: number): Array<number | null> {
  return atr(
    {
      high: view.bars.map((p) => Number(p.high.toString())),
      low: view.bars.map((p) => Number(p.low.toString())),
      close: view.bars.map((p) => Number(p.close.toString())),
    },
    period,
  );
}

/** The scale unit at one view index: Wilder ATR, or the configured percentage of the close in percent mode. Null when unavailable. */
export function scaleAt(view: PitView, atrs: ReadonlyArray<number | null>, params: PatternParameters, index: number): Decimal | null {
  if (params.tolerance.mode === 'percent') {
    const a = Decimal.from(params.tolerance.percentOfPrice).times(view.bars[index]!.close.abs());
    return a.isPositive() ? a : null;
  }
  const v = atrs[index];
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const a = Decimal.from(v.toFixed(10));
  return a.isPositive() ? a : null;
}

const RATIO_SCALE = 12;

function alternating(w: readonly SpaceSwing[]): boolean {
  for (let i = 1; i < w.length; i++) {
    if (w[i]!.kind === w[i - 1]!.kind) return false;
    if (w[i]!.index <= w[i - 1]!.index) return false;
  }
  return true;
}

interface DetectContext {
  view: PitView;
  atrs: ReadonlyArray<number | null>;
  params: PatternParameters;
  diagnostics: Diagnostics;
}

/** Head and shoulders top in the space. The mirrored space gives the inverse. */
function headAndShouldersIn(swings: readonly SpaceSwing[], mirrored: boolean, ctx: DetectContext): Candidate[] {
  const p = ctx.params.headShoulders;
  const out: Candidate[] = [];
  for (let j = 0; j + 4 < swings.length; j++) {
    const w = swings.slice(j, j + 5);
    if (w[0]!.kind !== 'high' || !alternating(w)) continue;
    const [h1, l1, h2, l2, h3] = w as [SpaceSwing, SpaceSwing, SpaceSwing, SpaceSwing, SpaceSwing];
    const span = h3.index - h1.index;
    if (span < p.minPatternBars || span > p.maxPatternBars) continue;
    const geometryKnownIndex = h3.confirmedIndex;
    const a = scaleAt(ctx.view, ctx.atrs, ctx.params, geometryKnownIndex);
    if (a === null) {
      ctx.diagnostics.rejectedNoScale++;
      continue;
    }
    const shoulderMax = h1.price.gt(h3.price) ? h1.price : h3.price;
    const prominence = h2.price.minus(shoulderMax);
    if (prominence.lt(Decimal.from(p.minHeadProminenceAtr).times(a))) continue;
    if (h1.price.minus(h3.price).abs().gt(Decimal.from(p.maxShoulderDifferenceAtr).times(a))) continue;
    const lowerNeck = l1.price.lt(h1.price) && l1.price.lt(h2.price);
    const lowerNeckRight = l2.price.lt(h2.price) && l2.price.lt(h3.price);
    if (!lowerNeck || !lowerNeckRight) continue;
    const left = h2.index - h1.index;
    const right = h3.index - h2.index;
    const longer = Math.max(left, right);
    const shorter = Math.min(left, right);
    const ratio = Decimal.from(longer).dividedBy(shorter, RATIO_SCALE, 'half_even');
    if (ratio.gt(p.maxShoulderDurationRatio)) continue;
    const neck = lineThrough(l1.index, l1.price, l2.index, l2.price);
    if (neck.b.abs().gt(Decimal.from(p.maxNecklineSlopeAtrPerBar).times(a))) continue;
    const height = h2.price.minus(valueAt(neck, h2.index));
    if (!height.isPositive()) continue;
    const breakout = Decimal.from(ctx.params.headShoulders.breakoutBufferAtr).times(a);
    const failure = Decimal.from(ctx.params.outcome.failureBufferAtr).times(a);
    const roles = ['left_shoulder', 'neckline_left', 'head', 'neckline_right', 'right_shoulder'];
    out.push({
      patternType: mirrored ? 'inverse_head_and_shoulders' : 'head_and_shoulders',
      mirrored,
      anchors: w.map((s, k) => ({ role: roles[k]!, kind: s.kind, price: s.price, index: s.index, confirmedIndex: s.confirmedIndex })),
      geometryKnownIndex,
      scale: a,
      boundaries: { breakDown: neck, invalidateUp: horizontal(h3.price), failUpAfterDown: neck },
      targetAt: (direction, confirmIndex) => (direction === 'down' ? valueAt(neck, confirmIndex).minus(height) : valueAt(neck, confirmIndex).plus(height)),
      targetMethod: 'head_to_neckline_projected_from_confirmation',
      invalidationRule: 'final_close_beyond_right_shoulder',
      invalidationLevel: h3.price,
      confirmationWindowBars: p.confirmationWindowBars,
      breakoutBuffer: breakout,
      failureBuffer: failure,
      targetTolerance: Decimal.from(ctx.params.outcome.targetToleranceAtr).times(a),
      maxOutcomeBars: ctx.params.outcome.maxOutcomeBars,
      direction: mirrored ? 'bullish' : 'bearish',
      metrics: {
        shoulderDifferenceAtr: h1.price.minus(h3.price).abs().dividedBy(a, 6, 'half_even').toFixed(6),
        headProminenceAtr: prominence.dividedBy(a, 6, 'half_even').toFixed(6),
        durationRatio: ratio.toFixed(4),
        necklineSlopeAtrPerBar: neck.b.abs().dividedBy(a, 6, 'half_even').toFixed(6),
      },
      lines: { neckline: neck },
    });
  }
  return out;
}

/** Double top in the space. The mirrored space gives the double bottom. */
function doubleTopIn(swings: readonly SpaceSwing[], mirrored: boolean, ctx: DetectContext): Candidate[] {
  const d = ctx.params.double;
  const out: Candidate[] = [];
  for (let j = 0; j + 2 < swings.length; j++) {
    const w = swings.slice(j, j + 3);
    if (w[0]!.kind !== 'high' || !alternating(w)) continue;
    const [h1, l1, h2] = w as [SpaceSwing, SpaceSwing, SpaceSwing];
    const separation = h2.index - h1.index;
    if (separation < d.minSeparationBars || separation > d.maxPatternBars) continue;
    const geometryKnownIndex = h2.confirmedIndex;
    const a = scaleAt(ctx.view, ctx.atrs, ctx.params, geometryKnownIndex);
    if (a === null) {
      ctx.diagnostics.rejectedNoScale++;
      continue;
    }
    if (h1.price.minus(h2.price).abs().gt(Decimal.from(d.maxPeakDifferenceAtr).times(a))) continue;
    const lowerPeak = h1.price.lt(h2.price) ? h1.price : h2.price;
    const higherPeak = h1.price.gt(h2.price) ? h1.price : h2.price;
    if (lowerPeak.minus(l1.price).lt(Decimal.from(d.minReactionDepthAtr).times(a))) continue;
    const peakReference = h1.price.plus(h2.price).dividedBy(2, 18, 'half_even');
    const height = peakReference.minus(l1.price);
    if (!height.isPositive()) continue;
    const neck = horizontal(l1.price);
    const roles = mirrored ? ['first_trough', 'neckline', 'second_trough'] : ['first_peak', 'neckline', 'second_peak'];
    out.push({
      patternType: mirrored ? 'double_bottom' : 'double_top',
      mirrored,
      anchors: w.map((s, k) => ({ role: roles[k]!, kind: s.kind, price: s.price, index: s.index, confirmedIndex: s.confirmedIndex })),
      geometryKnownIndex,
      scale: a,
      boundaries: { breakDown: neck, invalidateUp: horizontal(higherPeak), failUpAfterDown: neck },
      targetAt: (direction) => (direction === 'down' ? l1.price.minus(height) : l1.price.plus(height)),
      targetMethod: 'peak_reference_minus_formation_height',
      invalidationRule: 'final_close_beyond_higher_peak',
      invalidationLevel: higherPeak,
      confirmationWindowBars: d.confirmationWindowBars,
      breakoutBuffer: Decimal.from(d.breakoutBufferAtr).times(a),
      failureBuffer: Decimal.from(ctx.params.outcome.failureBufferAtr).times(a),
      targetTolerance: Decimal.from(ctx.params.outcome.targetToleranceAtr).times(a),
      maxOutcomeBars: ctx.params.outcome.maxOutcomeBars,
      direction: mirrored ? 'bullish' : 'bearish',
      metrics: {
        peakDifferenceAtr: h1.price.minus(h2.price).abs().dividedBy(a, 6, 'half_even').toFixed(6),
        reactionDepthAtr: lowerPeak.minus(l1.price).dividedBy(a, 6, 'half_even').toFixed(6),
        separationBars: String(separation),
      },
      lines: { neckline: neck },
    });
  }
  return out;
}

/** Triangles, on the real space. Consecutive alternating windows, longest valid first for each end swing. */
function trianglesIn(swings: readonly SpaceSwing[], ctx: DetectContext): Candidate[] {
  const t = ctx.params.triangle;
  const out: Candidate[] = [];
  const minLength = 2 * t.minTouchesPerSide;
  for (let e = 0; e < swings.length; e++) {
    for (let len = Math.min(t.maxTriangleSwings, e + 1); len >= minLength; len--) {
      const w = swings.slice(e - len + 1, e + 1);
      if (!alternating(w)) continue;
      const candidate = triangleOf(w, ctx);
      if (candidate) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}

function triangleOf(w: readonly SpaceSwing[], ctx: DetectContext): Candidate | null {
  const t = ctx.params.triangle;
  const first = w[0]!;
  const last = w[w.length - 1]!;
  const span = last.index - first.index;
  if (span < t.minPatternBars || span > t.maxPatternBars) return null;
  const highs: Touch[] = w.filter((s) => s.kind === 'high').map((s) => ({ x: s.index, y: s.price }));
  const lows: Touch[] = w.filter((s) => s.kind === 'low').map((s) => ({ x: s.index, y: s.price }));
  if (highs.length < t.minTouchesPerSide || lows.length < t.minTouchesPerSide) return null;
  const geometryKnownIndex = last.confirmedIndex;
  const a = scaleAt(ctx.view, ctx.atrs, ctx.params, geometryKnownIndex);
  if (a === null) {
    ctx.diagnostics.rejectedNoScale++;
    return null;
  }
  const upper = leastSquares(highs);
  const lower = leastSquares(lows);
  const resU = maxResidual(upper, highs);
  const resL = maxResidual(lower, lows);
  const maxRes = Decimal.from(t.maxResidualAtr).times(a);
  if (resU.gt(maxRes) || resL.gt(maxRes)) return null;
  const sU = upper.b.dividedBy(a, 12, 'half_even');
  const sL = lower.b.dividedBy(a, 12, 'half_even');
  const flat = Decimal.from(t.flatSlopeToleranceAtrPerBar);
  const trend = Decimal.from(t.minTrendSlopeAtrPerBar);
  const absU = sU.abs();
  const absL = sL.abs();
  let type: PatternType;
  if (absU.lte(flat) && sL.gte(trend)) type = 'ascending_triangle';
  else if (absL.lte(flat) && sU.lte(trend.negated())) type = 'descending_triangle';
  else if (sU.lte(trend.negated()) && sL.gte(trend)) type = 'symmetrical_triangle';
  else return null;
  // The formation must narrow, and the support must stay below the resistance at every anchor.
  for (const s of w) if (valueAt(upper, s.index).minus(valueAt(lower, s.index)).lte(0)) return null;
  const w0 = valueAt(upper, first.index).minus(valueAt(lower, first.index));
  const w1 = valueAt(upper, last.index).minus(valueAt(lower, last.index));
  const convergence = w0.minus(w1).dividedBy(w0, 12, 'half_even');
  if (convergence.lt(t.minConvergence)) return null;
  const apex = apexOf(upper, lower);
  if (apex === null) return null;
  const apexAhead = apex.minus(last.index);
  if (!apexAhead.isPositive() || apexAhead.gt(t.maxApexBarsAhead)) return null;
  const height = w0;
  const breakout = Decimal.from(t.breakoutBufferAtr).times(a);
  const failure = Decimal.from(ctx.params.outcome.failureBufferAtr).times(a);
  const boundaries: Candidate['boundaries'] = {};
  let invalidationLevel = w0;
  let invalidationRule = 'final_close_beyond_opposite_line';
  let direction: Candidate['direction'] = 'neutral';
  if (type === 'ascending_triangle') {
    boundaries.breakUp = upper;
    boundaries.invalidateDown = lower;
    boundaries.failDownAfterUp = upper;
    direction = 'bullish';
    invalidationLevel = valueAt(lower, last.index);
    invalidationRule = 'final_close_below_rising_support';
  } else if (type === 'descending_triangle') {
    boundaries.breakDown = lower;
    boundaries.invalidateUp = upper;
    boundaries.failUpAfterDown = lower;
    direction = 'bearish';
    invalidationLevel = valueAt(upper, last.index);
    invalidationRule = 'final_close_above_falling_resistance';
  } else {
    boundaries.breakUp = upper;
    boundaries.breakDown = lower;
    boundaries.failDownAfterUp = upper;
    boundaries.failUpAfterDown = lower;
  }
  const roles = (side: 'upper' | 'lower', k: number) => side + '_touch_' + (k + 1);
  let hi = 0;
  let lo = 0;
  return {
    patternType: type,
    mirrored: false,
    anchors: w.map((s) => ({ role: s.kind === 'high' ? roles('upper', hi++) : roles('lower', lo++), kind: s.kind, price: s.price, index: s.index, confirmedIndex: s.confirmedIndex })),
    geometryKnownIndex,
    scale: a,
    boundaries,
    targetAt: (direction, confirmIndex) => (direction === 'up' ? valueAt(upper, confirmIndex).plus(height) : valueAt(lower, confirmIndex).minus(height)),
    targetMethod: 'widest_formation_height_projected_from_breakout',
    invalidationRule,
    invalidationLevel,
    confirmationWindowBars: t.confirmationWindowBars,
    breakoutBuffer: breakout,
    failureBuffer: failure,
    targetTolerance: Decimal.from(ctx.params.outcome.targetToleranceAtr).times(a),
    maxOutcomeBars: ctx.params.outcome.maxOutcomeBars,
    direction,
    metrics: {
      upperSlopeAtrPerBar: sU.toFixed(6),
      lowerSlopeAtrPerBar: sL.toFixed(6),
      lineResidualAtr: (resU.gt(resL) ? resU : resL).dividedBy(a, 6, 'half_even').toFixed(6),
      apexBarsAhead: apexAhead.toFixed(2),
      convergence: convergence.toFixed(4),
      upperTouches: String(highs.length),
      lowerTouches: String(lows.length),
    },
    lines: { upper, lower },
  };
}

/** All candidates of the view: head and shoulders and double tops in the real and mirrored spaces, and triangles on the real space. */
export function detectCandidates(view: PitView, params: PatternParameters): { candidates: Candidate[]; diagnostics: Diagnostics } {
  const atrs = atrSeriesOf(view, params.tolerance.atrPeriod);
  const diagnostics: Diagnostics = { swings: 0, candidates: 0, rejectedNoScale: 0 };
  const ctx: DetectContext = { view, atrs, params, diagnostics };
  const real = spaceOf(view, false);
  const mirror = spaceOf(view, true);
  const realSwings = swingsOf(real, params.swing.leftBars, params.swing.rightBars);
  const mirrorSwings = swingsOf(mirror, params.swing.leftBars, params.swing.rightBars);
  diagnostics.swings = realSwings.length;
  const candidates: Candidate[] = [
    ...headAndShouldersIn(realSwings, false, ctx),
    ...doubleTopIn(realSwings, false, ctx),
    ...headAndShouldersIn(mirrorSwings, true, ctx),
    ...doubleTopIn(mirrorSwings, true, ctx),
    ...trianglesIn(realSwings, ctx),
  ];
  diagnostics.candidates = candidates.length;
  return { candidates, diagnostics };
}

/** Negates a line of a mirrored candidate back to the original price space. */
export function originalLine(line: Line, mirrored: boolean): Line {
  return mirrored ? { a: line.a.negated(), b: line.b.negated() } : line;
}
