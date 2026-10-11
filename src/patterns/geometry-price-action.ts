// Rectangles, channels and wedges (docs/PATTERN_ENGINE_V1B.md §10–§13). A rectangle is an upper and a lower horizontal support/resistance cluster,
// born once, when the later of the two levels is confirmed. A channel or a wedge is two fitted swing lines over a bounded window of consecutive,
// alternating confirmed swings. Each candidate has frozen boundaries and then walks the V1 lifecycle (walkCandidate).

import { Decimal } from '../money/decimal.js';
import { leastSquares, maxResidual, apexOf, horizontal, valueAt, type Touch, type Line } from './line.js';
import { scaleAt, type Anchor, type Candidate, type SpaceSwing } from './geometry.js';
import type { FrameLevel, PatternLevel } from './levels.js';
import type { PitView } from './pit-view.js';
import type { PatternParameters } from './pattern-parameters.js';

const RATIO_SCALE = 12;

export interface PriceActionShapes {
  candidates: Candidate[];
  rectangleBirthChecks: number;
  channelWedgeWindows: number;
}

/** Rectangles: a support level below and a resistance level above the close at the birth bar, both with enough touches, flat, and wide enough. */
export function rectanglesIn(view: PitView, params: PatternParameters, atrs: ReadonlyArray<number | null>, frames: readonly (readonly FrameLevel[])[]): { candidates: Candidate[]; births: number } {
  const r = params.rectangle;
  const out: Candidate[] = [];
  let births = 0;
  const last = view.bars.length - 1;
  for (let F = 1; F <= last; F++) {
    const A = scaleAt(view, atrs, params, F);
    if (A === null) continue;
    const levels = frames[F] ?? [];
    const close = view.bars[F]!.close;
    for (const S of levels) {
      for (const R of levels) {
        if (!S.priceLevel.lt(R.priceLevel)) continue;
        if (!(S.priceLevel.lt(close) && close.lt(R.priceLevel))) continue;
        births++;
        // The pair is born only when its later level is confirmed here: a later touch on an existing level never creates a second rectangle.
        if (Math.max(S.confirmedIndex, R.confirmedIndex) !== F) continue;
        if (R.touches.length < r.minTouchesPerSide || S.touches.length < r.minTouchesPerSide) continue;
        const all = [...R.touches, ...S.touches];
        const first = Math.min(...all.map((t) => t.index));
        const lastTouch = Math.max(...all.map((t) => t.index));
        const duration = lastTouch - first;
        if (duration < r.minDurationBars || duration > r.maxDurationBars) continue;
        const height = R.priceLevel.minus(S.priceLevel);
        if (height.lt(Decimal.from(r.minHeightAtr).times(A))) continue;
        const flat = Decimal.from(r.flatSlopeToleranceAtrPerBar);
        const lineR = leastSquares(toTouches(R));
        const lineS = leastSquares(toTouches(S));
        if (lineR.b.dividedBy(A, RATIO_SCALE, 'half_even').abs().gt(flat) || lineS.b.dividedBy(A, RATIO_SCALE, 'half_even').abs().gt(flat)) continue;
        const maxRes = Decimal.from(r.maxResidualAtr).times(A);
        const resR = maxResidual(lineR, toTouches(R));
        const resS = maxResidual(lineS, toTouches(S));
        if (resR.gt(maxRes) || resS.gt(maxRes)) continue;
        out.push(rectangleCandidate(params, F, A, R, S, duration, height, resR.gt(resS) ? resR : resS, lineR, lineS));
      }
    }
  }
  return { candidates: out, births };
}

function toTouches(level: PatternLevel): Touch[] {
  return level.touches.map((t) => ({ x: t.index, y: t.price }));
}

function rectangleCandidate(params: PatternParameters, F: number, A: Decimal, R: FrameLevel, S: FrameLevel, duration: number, height: Decimal, residual: Decimal, lineR: Line, lineS: Line): Candidate {
  const pa = params.priceAction;
  const anchors = (level: PatternLevel, role: string): Anchor[] =>
    [...level.touches].sort((a, b) => a.index - b.index).map((t, k) => ({ role: role + '_touch_' + (k + 1), kind: t.kind, price: t.price, index: t.index, confirmedIndex: t.confirmedIndex }));
  const up = R.priceLevel;
  const down = S.priceLevel;
  return {
    patternType: 'rectangle',
    mirrored: false,
    anchors: [...anchors(R, 'resistance'), ...anchors(S, 'support')],
    geometryKnownIndex: F,
    scale: A,
    boundaries: { breakUp: horizontal(up), breakDown: horizontal(down), failDownAfterUp: horizontal(up), failUpAfterDown: horizontal(down) },
    targetAt: (direction) => (direction === 'up' ? up.plus(height) : down.minus(height)),
    targetMethod: 'rectangle_height_projected_from_break',
    invalidationRule: 'no_invalidation_before_break',
    invalidationLevel: down,
    confirmationWindowBars: params.rectangle.confirmationWindowBars,
    breakoutBuffer: Decimal.from(pa.breakoutBufferAtr).times(A),
    failureBuffer: Decimal.from(params.outcome.failureBufferAtr).times(A),
    targetTolerance: Decimal.from(params.outcome.targetToleranceAtr).times(A),
    maxOutcomeBars: params.outcome.maxOutcomeBars,
    direction: 'neutral',
    metrics: {
      durationBars: String(duration),
      upperTouches: String(R.touches.length),
      lowerTouches: String(S.touches.length),
      heightAtr: height.dividedBy(A, 6, 'half_even').toFixed(6),
      upperSlopeAtrPerBar: lineR.b.dividedBy(A, 6, 'half_even').toFixed(6),
      lowerSlopeAtrPerBar: lineS.b.dividedBy(A, 6, 'half_even').toFixed(6),
      maxResidualAtr: residual.dividedBy(A, 6, 'half_even').toFixed(6),
      // The lineage of each side and its touch composition, as they stood at birth (docs/PATTERN_ENGINE_V1B.md §25.9).
      upperLineageId: R.levelLineageId,
      lowerLineageId: S.levelLineageId,
      upperHighTouchCount: String(R.highTouchCount),
      upperLowTouchCount: String(R.lowTouchCount),
      lowerHighTouchCount: String(S.highTouchCount),
      lowerLowTouchCount: String(S.lowTouchCount),
    },
    lines: { upper: horizontal(up), lower: horizontal(down) },
  };
}

/** Channels and wedges: consecutive alternating confirmed swings, the longest valid window per end swing, bounded by maxSwings. */
export function linesStructuresIn(view: PitView, params: PatternParameters, atrs: ReadonlyArray<number | null>, swings: readonly SpaceSwing[]): PriceActionShapes {
  const out: Candidate[] = [];
  let windows = 0;
  const maxSwings = Math.max(params.channel.maxSwings, params.wedge.maxSwings);
  const minLength = 2 * Math.min(params.channel.minTouchesPerSide, params.wedge.minTouchesPerSide);
  for (let e = 0; e < swings.length; e++) {
    for (let len = Math.min(maxSwings, e + 1); len >= minLength; len--) {
      windows++;
      const w = swings.slice(e - len + 1, e + 1);
      if (!alternating(w)) continue;
      const candidate = classifyLines(view, params, atrs, w);
      if (candidate) {
        out.push(candidate);
        break;
      }
    }
  }
  return { candidates: out, rectangleBirthChecks: 0, channelWedgeWindows: windows };
}

function alternating(w: readonly SpaceSwing[]): boolean {
  for (let i = 1; i < w.length; i++) {
    if (w[i]!.kind === w[i - 1]!.kind) return false;
    if (w[i]!.index <= w[i - 1]!.index) return false;
  }
  return true;
}

/**
 * One window as a channel or a wedge, or nothing. Both lines are fitted exactly. Slopes are in ATR per bar. The categories are disjoint by the
 * parameter relations checked in resolvePatternParameters: a channel's width barely changes, a wedge's width converges by at least minConvergence,
 * and a wedge's slopes are never flat.
 */
function classifyLines(view: PitView, params: PatternParameters, atrs: ReadonlyArray<number | null>, w: readonly SpaceSwing[]): Candidate | null {
  const first = w[0]!;
  const last = w[w.length - 1]!;
  const highs: Touch[] = w.filter((s) => s.kind === 'high').map((s) => ({ x: s.index, y: s.price }));
  const lows: Touch[] = w.filter((s) => s.kind === 'low').map((s) => ({ x: s.index, y: s.price }));
  const duration = last.index - first.index;
  const minTouches = Math.min(params.channel.minTouchesPerSide, params.wedge.minTouchesPerSide);
  if (highs.length < minTouches || lows.length < minTouches) return null;
  const A = scaleAt(view, atrs, params, last.confirmedIndex);
  if (A === null) return null;
  const upper = leastSquares(highs);
  const lower = leastSquares(lows);
  const resU = maxResidual(upper, highs);
  const resL = maxResidual(lower, lows);
  const sU = upper.b.dividedBy(A, RATIO_SCALE, 'half_even');
  const sL = lower.b.dividedBy(A, RATIO_SCALE, 'half_even');
  const w0 = valueAt(upper, first.index).minus(valueAt(lower, first.index));
  const w1 = valueAt(upper, last.index).minus(valueAt(lower, last.index));
  if (!w0.isPositive() || !w1.isPositive()) return null;
  const change = w1.dividedBy(w0, RATIO_SCALE, 'half_even').minus(1).abs();
  const convergence = w0.minus(w1).dividedBy(w0, RATIO_SCALE, 'half_even');
  const apex = apexOf(upper, lower);
  const apexAhead = apex === null ? null : apex.minus(last.index);
  const common = {
    mirrored: false,
    anchors: w.map((s) => ({ role: (s.kind === 'high' ? 'upper' : 'lower') + '_touch', kind: s.kind, price: s.price, index: s.index, confirmedIndex: s.confirmedIndex })),
    geometryKnownIndex: last.confirmedIndex,
    scale: A,
    boundaries: { breakUp: upper, breakDown: lower, failDownAfterUp: upper, failUpAfterDown: lower } as Candidate['boundaries'],
    invalidationRule: 'no_invalidation_before_break',
    invalidationLevel: valueAt(lower, last.index),
    breakoutBuffer: Decimal.from(params.priceAction.breakoutBufferAtr).times(A),
    failureBuffer: Decimal.from(params.outcome.failureBufferAtr).times(A),
    targetTolerance: Decimal.from(params.outcome.targetToleranceAtr).times(A),
    maxOutcomeBars: params.outcome.maxOutcomeBars,
    direction: 'neutral' as const,
    lines: { upper, lower },
  };
  const targetAt = (direction: 'up' | 'down', confirmIndex: number) => (direction === 'up' ? valueAt(upper, confirmIndex).plus(w0) : valueAt(lower, confirmIndex).minus(w0));
  const metrics = {
    upperSlopeAtrPerBar: sU.toFixed(6),
    lowerSlopeAtrPerBar: sL.toFixed(6),
    slopeDifferenceAtrPerBar: sU.minus(sL).abs().toFixed(6),
    maxResidualAtr: (resU.gt(resL) ? resU : resL).dividedBy(A, 6, 'half_even').toFixed(6),
    widthStartAtr: w0.dividedBy(A, 6, 'half_even').toFixed(6),
    widthEndAtr: w1.dividedBy(A, 6, 'half_even').toFixed(6),
    durationBars: String(duration),
    upperTouches: String(highs.length),
    lowerTouches: String(lows.length),
  };

  // Channel: two lines with the same slope sign, parallel, and a width that stays within the stability tolerance.
  const c = params.channel;
  const cMin = Decimal.from(c.minSlopeAtrPerBar);
  const channelDuration = duration >= c.minDurationBars && duration <= c.maxDurationBars;
  const channelResidual = (resU.gt(resL) ? resU : resL).lte(Decimal.from(c.maxResidualAtr).times(A));
  const parallel = sU.minus(sL).abs().lte(Decimal.from(c.maxSlopeDifferenceAtrPerBar));
  const widthStable = change.lte(Decimal.from(c.maxWidthChangeRatio));
  if (channelDuration && channelResidual && parallel && widthStable) {
    if (sU.gte(cMin) && sL.gte(cMin)) return { ...common, patternType: 'ascending_channel', geometryKnownIndex: last.confirmedIndex, confirmationWindowBars: c.confirmationWindowBars, targetAt, targetMethod: 'formation_width_projected_from_break', metrics: { ...metrics, convergence: convergence.toFixed(6) } };
    if (sU.lte(cMin.negated()) && sL.lte(cMin.negated())) return { ...common, patternType: 'descending_channel', geometryKnownIndex: last.confirmedIndex, confirmationWindowBars: c.confirmationWindowBars, targetAt, targetMethod: 'formation_width_projected_from_break', metrics: { ...metrics, convergence: convergence.toFixed(6) } };
  }

  // Wedge: both slopes beyond the minimum with the same sign, converging by at least minConvergence, with the apex ahead of the window.
  const wd = params.wedge;
  const wMin = Decimal.from(wd.minSlopeAtrPerBar);
  const wedgeDuration = duration >= wd.minDurationBars && duration <= wd.maxDurationBars;
  const wedgeResidual = (resU.gt(resL) ? resU : resL).lte(Decimal.from(wd.maxResidualAtr).times(A));
  const converging = convergence.gte(Decimal.from(wd.minConvergence));
  const apexOk = apexAhead !== null && apexAhead.isPositive() && apexAhead.lte(wd.maxApexBarsAhead);
  if (wedgeDuration && wedgeResidual && converging && apexOk) {
    const wedgeMetrics = { ...metrics, convergence: convergence.toFixed(6), apexBarsAhead: apexAhead!.toFixed(2) };
    if (sU.gte(wMin) && sL.gte(wMin) && sL.gt(sU))
      return { ...common, patternType: 'rising_wedge', geometryKnownIndex: last.confirmedIndex, confirmationWindowBars: wd.confirmationWindowBars, targetAt, targetMethod: 'formation_width_projected_from_break', metrics: wedgeMetrics };
    if (sU.lte(wMin.negated()) && sL.lte(wMin.negated()) && sU.lt(sL))
      return { ...common, patternType: 'falling_wedge', geometryKnownIndex: last.confirmedIndex, confirmationWindowBars: wd.confirmationWindowBars, targetAt, targetMethod: 'formation_width_projected_from_break', metrics: wedgeMetrics };
  }
  return null;
}
