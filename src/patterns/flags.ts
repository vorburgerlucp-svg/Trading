// Flags and pennants (pole-policy:v1, flag-pennant:v1; docs/PATTERN_ENGINE_V1C.md §14–§18). A flag or pennant needs a valid impulse pole, which ends
// before its consolidation begins. The consolidation is fitted with the existing line and apex mathematics (line.ts). Bear patterns are the bull
// definitions on the mirrored space, as V1 does for bottoms. The lifecycle is the V1 walk: forming, confirmed in the pole direction, invalidated on
// a decisive opposite close.

import { Decimal } from '../money/decimal.js';
import { apexOf, leastSquares, maxResidual, valueAt, type Line, type Touch } from './line.js';
import { scaleAt, spaceOf, type Anchor, type Candidate, type Space, type SpaceSwing } from './geometry.js';
import type { PitView } from './pit-view.js';
import type { PatternParameters } from './pattern-parameters.js';
import type { PatternType } from './pattern-types.js';

const RATIO_SCALE = 12;

export interface PoleCheck {
  accepted: boolean;
  /** |close(end) − close(start)| divided by the sum of the absolute close-to-close changes. */
  efficiency: Decimal;
  /** The largest drawdown from a running close peak, divided by the pole move. */
  retracement: Decimal;
}

/** pole-policy:v1 on the closes from the pole start to the pole end. Exact decimals. Thresholds are inclusive. */
export function poleChecks(closes: readonly Decimal[], move: Decimal, pole: PatternParameters['pole']): PoleCheck {
  const net = closes[closes.length - 1]!.minus(closes[0]!).abs();
  let sumAbs = Decimal.ZERO;
  for (let t = 1; t < closes.length; t++) sumAbs = sumAbs.plus(closes[t]!.minus(closes[t - 1]!).abs());
  const efficiency = sumAbs.isZero() ? Decimal.ZERO : net.dividedBy(sumAbs, RATIO_SCALE, 'half_even');
  let peak = closes[0]!;
  let maxDrawdown = Decimal.ZERO;
  for (const c of closes) {
    if (c.gt(peak)) peak = c;
    const dd = peak.minus(c);
    if (dd.gt(maxDrawdown)) maxDrawdown = dd;
  }
  const retracement = move.isPositive() ? maxDrawdown.dividedBy(move, RATIO_SCALE, 'half_even') : Decimal.ZERO;
  const accepted = efficiency.gte(Decimal.from(pole.minDirectionalEfficiency)) && retracement.lte(Decimal.from(pole.maxInternalRetracement));
  return { accepted, efficiency, retracement };
}

interface Pole {
  start: SpaceSwing;
  end: SpaceSwing;
  move: Decimal;
  bars: number;
  check: PoleCheck;
  scale: Decimal;
}

/** The nearest valid pole that ends at `endIdx` in the space (the bull orientation: a low start, a high end). Bounded by maxStartSwings. */
function findPole(view: PitView, params: PatternParameters, atrs: ReadonlyArray<number | null>, space: Space, swings: readonly SpaceSwing[], endIdx: number, counter: { poleChecks: number }): Pole | null {
  const end = swings[endIdx]!;
  if (end.kind !== 'high') return null;
  const pole = params.pole;
  for (let k = endIdx - 1; k >= Math.max(0, endIdx - pole.maxStartSwings); k--) {
    const start = swings[k]!;
    if (start.kind !== 'low') continue;
    counter.poleChecks++;
    const bars = end.index - start.index;
    if (bars < pole.minBars || bars > pole.maxBars) continue;
    const move = end.price.minus(start.price);
    if (!move.isPositive()) continue;
    const scale = scaleAt(view, atrs, params, end.confirmedIndex);
    if (scale === null) continue;
    if (move.lt(Decimal.from(pole.minMoveAtr).times(scale))) continue;
    const closes = space.close.slice(start.index, end.index + 1);
    const check = poleChecks(closes, move, pole);
    if (!check.accepted) continue;
    return { start, end, move, bars, check, scale };
  }
  return null;
}

function alternating(w: readonly SpaceSwing[]): boolean {
  for (let i = 1; i < w.length; i++) {
    if (w[i]!.kind === w[i - 1]!.kind) return false;
    if (w[i]!.index <= w[i - 1]!.index) return false;
  }
  return true;
}

export interface FlagScan {
  candidates: Candidate[];
  poleChecks: number;
  windows: number;
}

/**
 * The flags and pennants of the view, in both orientations: the real space gives the bull patterns, the mirrored space the bear patterns. For each
 * consolidation start (a low after a pole high), the nearest valid pole is taken, and the longest valid consolidation window is kept.
 */
export function detectFlags(view: PitView, params: PatternParameters, atrs: ReadonlyArray<number | null>, realSwings: readonly SpaceSwing[], mirrorSwings: readonly SpaceSwing[]): FlagScan {
  const out: Candidate[] = [];
  const counter = { poleChecks: 0 };
  let windows = 0;
  for (const mirrored of [false, true]) {
    const space = spaceOf(view, mirrored);
    const swings = mirrored ? mirrorSwings : realSwings;
    for (let j = 1; j < swings.length; j++) {
      if (swings[j]!.kind !== 'low') continue;
      const pole = findPole(view, params, atrs, space, swings, j - 1, counter);
      if (pole === null) continue;
      const maxEnd = Math.min(swings.length - 1, j + params.flag.maxSwings - 1);
      for (let e = maxEnd; e >= j + 3; e--) {
        windows++;
        const w = swings.slice(j, e + 1);
        if (!alternating(w)) continue;
        const candidate = consolidationOf(view, params, atrs, pole, w, mirrored);
        if (candidate !== null) {
          out.push(candidate);
          break;
        }
      }
    }
  }
  return { candidates: out, poleChecks: counter.poleChecks, windows };
}

/** One consolidation window as a bull flag, a bull pennant, or nothing (and their bear mirrors when mirrored). */
function consolidationOf(view: PitView, params: PatternParameters, atrs: ReadonlyArray<number | null>, pole: Pole, w: readonly SpaceSwing[], mirrored: boolean): Candidate | null {
  const first = w[0]!;
  const last = w[w.length - 1]!;
  const highs: Touch[] = w.filter((s) => s.kind === 'high').map((s) => ({ x: s.index, y: s.price }));
  const lows: Touch[] = w.filter((s) => s.kind === 'low').map((s) => ({ x: s.index, y: s.price }));
  const scale = scaleAt(view, atrs, params, last.confirmedIndex);
  if (scale === null) return null;
  const upper = leastSquares(highs);
  const lower = leastSquares(lows);
  const resid = maxResidual(upper, highs).gt(maxResidual(lower, lows)) ? maxResidual(upper, highs) : maxResidual(lower, lows);
  const sU = upper.b.dividedBy(scale, RATIO_SCALE, 'half_even');
  const sL = lower.b.dividedBy(scale, RATIO_SCALE, 'half_even');
  const w0 = valueAt(upper, first.index).minus(valueAt(lower, first.index));
  const w1 = valueAt(upper, last.index).minus(valueAt(lower, last.index));
  if (!w0.isPositive() || !w1.isPositive()) return null;
  const flagBars = last.index - pole.end.index;
  const minLow = lows.reduce((m, t) => (t.y.lt(m) ? t.y : m), lows[0]!.y);
  const retracement = pole.end.price.minus(minLow).dividedBy(pole.move, RATIO_SCALE, 'half_even');
  const sign = mirrored ? -1 : 1;
  const convergence = w0.minus(w1).dividedBy(w0, RATIO_SCALE, 'half_even');
  const apex = apexOf(upper, lower);
  const apexAhead = apex === null ? null : apex.minus(last.index);

  const f = params.flag;
  const flagOk =
    flagBars >= f.minBars &&
    Decimal.from(flagBars).lte(Decimal.from(f.maxBarsToPoleRatio).times(pole.bars)) &&
    retracement.lte(Decimal.from(f.maxRetracementOfPole)) &&
    resid.lte(Decimal.from(f.maxResidualAtr).times(scale)) &&
    highs.length >= f.minTouchesPerSide &&
    lows.length >= f.minTouchesPerSide &&
    sU.lte(Decimal.from(f.maxFlatSlopeAtrPerBar)) &&
    sL.lte(Decimal.from(f.maxFlatSlopeAtrPerBar)) &&
    sU.minus(sL).abs().lte(Decimal.from(f.maxParallelDiffAtr));

  const q = params.pennant;
  const minSlope = Decimal.from(q.minSlopeAtrPerBar);
  const pennantOk =
    !flagOk &&
    flagBars >= q.minBars &&
    Decimal.from(flagBars).lte(Decimal.from(q.maxBarsToPoleRatio).times(pole.bars)) &&
    retracement.lte(Decimal.from(q.maxRetracementOfPole)) &&
    resid.lte(Decimal.from(q.maxResidualAtr).times(scale)) &&
    highs.length >= q.minTouchesPerSide &&
    lows.length >= q.minTouchesPerSide &&
    sU.lte(minSlope.negated()) &&
    sL.gte(minSlope) &&
    convergence.gte(Decimal.from(q.minConvergence)) &&
    apexAhead !== null &&
    apexAhead.isPositive() &&
    apexAhead.lte(q.maxApexBarsAhead);

  if (!flagOk && !pennantOk) return null;
  const type: PatternType = flagOk ? (mirrored ? 'bear_flag' : 'bull_flag') : mirrored ? 'bear_pennant' : 'bull_pennant';
  const touches = [...w].sort((a, b) => a.index - b.index);
  const upperRole = (k: number) => 'upper_touch_' + k;
  const lowerRole = (k: number) => 'lower_touch_' + k;
  let hi = 0;
  let lo = 0;
  const consolidationAnchors: Anchor[] = touches.map((s) => ({
    role: s.kind === 'high' ? upperRole(++hi) : lowerRole(++lo),
    kind: s.kind,
    price: s.price,
    index: s.index,
    confirmedIndex: s.confirmedIndex,
  }));
  const anchors: Anchor[] = [
    { role: 'pole_start', kind: pole.start.kind, price: pole.start.price, index: pole.start.index, confirmedIndex: pole.start.confirmedIndex },
    { role: 'pole_end', kind: pole.end.kind, price: pole.end.price, index: pole.end.index, confirmedIndex: pole.end.confirmedIndex },
    ...consolidationAnchors,
  ];
  const poleMove = pole.move;
  const targetAt = (direction: 'up' | 'down', confirmIndex: number) => (direction === 'up' ? valueAt(upper, confirmIndex).plus(poleMove) : valueAt(lower, confirmIndex).minus(poleMove));
  const lines: Record<string, Line> = { upper, lower };
  const slopeText = (v: Decimal) => v.times(sign).toFixed(6);
  const metrics: Record<string, string> = {
    poleBars: String(pole.bars),
    poleMoveAtr: pole.move.dividedBy(pole.scale, 6, 'half_even').toFixed(6),
    poleEfficiency: pole.check.efficiency.toFixed(6),
    poleRetracement: pole.check.retracement.toFixed(6),
    flagBars: String(flagBars),
    retracementOfPole: retracement.toFixed(6),
    upperSlopeAtrPerBar: slopeText(sU),
    lowerSlopeAtrPerBar: slopeText(sL),
    slopeDifferenceAtrPerBar: sU.minus(sL).abs().toFixed(6),
    maxResidualAtr: resid.dividedBy(scale, 6, 'half_even').toFixed(6),
    widthStartAtr: w0.dividedBy(scale, 6, 'half_even').toFixed(6),
    widthEndAtr: w1.dividedBy(scale, 6, 'half_even').toFixed(6),
    upperTouches: String(highs.length),
    lowerTouches: String(lows.length),
    poleStartTime: view.bars[pole.start.index]!.startTime,
    poleEndTime: view.bars[pole.end.index]!.startTime,
  };
  if (!flagOk) {
    metrics.convergence = convergence.toFixed(6);
    metrics.apexBarsAhead = apexAhead!.toFixed(2);
  }
  return {
    patternType: type,
    mirrored,
    anchors,
    geometryKnownIndex: last.confirmedIndex,
    scale,
    boundaries: { breakUp: upper, invalidateDown: lower, failDownAfterUp: upper } as Candidate['boundaries'],
    targetAt,
    targetMethod: 'pole_length_projected_from_breakout',
    invalidationRule: 'final_close_beyond_opposite_consolidation_line',
    invalidationLevel: valueAt(lower, last.index),
    confirmationWindowBars: flagOk ? f.confirmationWindowBars : q.confirmationWindowBars,
    breakoutBuffer: Decimal.from(params.priceAction.breakoutBufferAtr).times(scale),
    failureBuffer: Decimal.from(params.outcome.failureBufferAtr).times(scale),
    targetTolerance: Decimal.from(params.outcome.targetToleranceAtr).times(scale),
    maxOutcomeBars: params.outcome.maxOutcomeBars,
    direction: 'neutral',
    metrics,
    lines,
  };
}
