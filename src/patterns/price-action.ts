// Breakouts, retests and false breaks (price-action-lifecycle:v1; docs/PATTERN_ENGINE_V1B.md §5–§8, §25). Every decision is a final-close comparison
// on exact decimals against a level that existed before the decision bar. The retest and the failure are walked from the bar after the breakout.
// The breakout binds to the structural lineage of its level, not to the evidence revision; the evidence used is recorded.

import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { scaleAt } from './geometry.js';
import type { FrameLevel, LevelTouch } from './levels.js';
import { V1B_IDENTITY, type PatternParameters } from './pattern-parameters.js';
import type { PitView } from './pit-view.js';
import type { PatternAnchor, PatternLevelEvidence, PatternLineage, PatternObservation, PatternSeries, PatternStatus, PatternType } from './pattern-types.js';

export interface PriceActionContext {
  instrumentId: string;
  interval: string;
  series: PatternSeries;
}

/** A price-action observation before the run adds its per-asOf identity and metadata. */
export type PriceActionDraft = Omit<PatternObservation, 'patternObservationId' | 'asOf' | 'instrumentId' | 'interval' | 'series' | 'chartContext' | 'evidenceRefs'>;

export interface PriceActionResult {
  drafts: PriceActionDraft[];
  levelEvaluations: number;
  breakoutCount: number;
  barsWalked: number;
}

interface BreakoutWalk {
  /** View index of the first retest touch of the zone (a bar that does not fail). */
  touchedAt: number | null;
  /** View index of the first hold after a touch. */
  holdAt: number | null;
  /** View index of the failure close. */
  failedAt: number | null;
  barsWalked: number;
}

/** The lifecycle of one breakout, from the bar after the breakout. Thresholds use the ATR at the breakout bar, frozen for the lifecycle. */
function walkBreakout(view: PitView, pa: PatternParameters['priceAction'], B: number, L: Decimal, up: boolean, A: Decimal, last: number): BreakoutWalk {
  const failBuf = Decimal.from(pa.failureBufferAtr).times(A);
  const tol = Decimal.from(pa.retestToleranceAtr).times(A);
  const hold = Decimal.from(pa.retestHoldBufferAtr).times(A);
  const horizon = Math.max(pa.retestWindowBars, pa.failureWindowBars);
  let touchedAt: number | null = null;
  let holdAt: number | null = null;
  let failedAt: number | null = null;
  let barsWalked = 0;
  for (let t = B + 1; t <= last && t - B <= horizon; t++) {
    barsWalked++;
    const bar = view.bars[t]!;
    const failed = t - B <= pa.failureWindowBars && (up ? bar.close.lt(L.minus(failBuf)) : bar.close.gt(L.plus(failBuf)));
    // A bar that fails on its close is a failure, not a retest: the touch of that bar is not counted.
    if (failed) {
      failedAt = t;
      break;
    }
    if (t - B > pa.retestWindowBars) continue;
    if (touchedAt === null && (up ? bar.low.lte(L.plus(tol)) : bar.high.gte(L.minus(tol)))) touchedAt = t;
    if (touchedAt !== null && holdAt === null && (up ? bar.close.gte(L.plus(hold)) : bar.close.lte(L.minus(hold)))) holdAt = t;
  }
  return { touchedAt, holdAt, failedAt, barsWalked };
}

function touchAnchors(view: PitView, touches: readonly LevelTouch[], side: 'resistance' | 'support'): PatternAnchor[] {
  return [...touches]
    .sort((a, b) => a.index - b.index)
    .map((t, k) => ({ role: side + '_touch_' + (k + 1), kind: t.kind, price: t.price.toString(), time: t.time, barIndex: t.index, confirmedAt: view.bars[t.confirmedIndex]!.instant }));
}

/** The structures of one breakout: the breakout itself, its retest if one was touched, and its false break if it failed. */
function structuresOf(view: PitView, pa: PatternParameters['priceAction'], ctx: PriceActionContext, level: FrameLevel, B: number, up: boolean, A: Decimal, last: number, walk: BreakoutWalk): PriceActionDraft[] {
  const L = level.priceLevel;
  const buf = Decimal.from(pa.breakoutBufferAtr).times(A);
  const failBuf = Decimal.from(pa.failureBufferAtr).times(A);
  const at = (t: number) => view.bars[t]!.instant;
  const direction = up ? 'up' : 'down';
  // The structural identity: lineage, not evidence (docs/PATTERN_ENGINE_V1B.md §25.5).
  const instanceId = 'pi_' + hashOf({ kind: 'price-action-instance', family: V1B_IDENTITY.engine, instrumentId: ctx.instrumentId, interval: ctx.interval, series: ctx.series, levelLineageId: level.levelLineageId, direction }).slice(0, 40);
  const eventFamilyId = 'ef_' + hashOf({ kind: 'price-action-event-family', instrumentId: ctx.instrumentId, interval: ctx.interval, series: ctx.series, levelLineageId: level.levelLineageId, direction }).slice(0, 40);
  const levelEvidence: PatternLevelEvidence = {
    levelLineageId: level.levelLineageId,
    levelEvidenceId: level.levelEvidenceId,
    priceLevel: L.toString(),
    touchCount: level.touches.length,
    highTouchCount: level.highTouchCount,
    lowTouchCount: level.lowTouchCount,
    evidenceConfirmedAt: level.confirmedAt,
  };
  const side = up ? 'resistance' : 'support';
  const common = {
    anchors: touchAnchors(view, level.touches, side),
    invalidation: { rule: 'final_close_beyond_failure_boundary', level: (up ? L.minus(failBuf) : L.plus(failBuf)).toString() },
    target: { method: 'none', price: null },
    boundaries: { level: { intercept: L.toString(), slope: '0' } },
    geometryMetrics: { touchCount: String(level.touches.length), highTouchCount: String(level.highTouchCount), lowTouchCount: String(level.lowTouchCount) },
    invalidatedAt: null,
    levelEvidence,
  };
  const breakoutConfirmation = { direction: up ? ('up' as const) : ('down' as const), level: L.toString(), buffer: buf.toString(), confirmedByBarTime: view.bars[B]!.startTime };
  const out: PriceActionDraft[] = [];
  const root: PatternLineage = { eventFamilyId, parentPatternInstanceId: null, rootPatternInstanceId: instanceId, relationship: 'root' };
  out.push({
    ...common,
    patternInstanceId: instanceId,
    patternType: (up ? 'resistance_breakout' : 'support_breakdown') as PatternType,
    direction: up ? 'bullish' : 'bearish',
    status: 'confirmed' as PatternStatus,
    firstSeenAt: at(B),
    confirmedAt: at(B),
    resolvedAt: null,
    confirmation: breakoutConfirmation,
    patternLineage: root,
  });

  if (walk.touchedAt !== null) {
    const t = walk.touchedAt;
    const status: PatternStatus =
      walk.failedAt !== null && walk.holdAt === null ? 'failed_breakout' : walk.holdAt !== null ? 'retest_confirmed' : last - B > pa.retestWindowBars ? 'expired' : 'retest_pending';
    const bar = view.bars[t]!;
    const retestAnchor: PatternAnchor = { role: 'retest_touch', kind: up ? 'low' : 'high', price: (up ? bar.low : bar.high).toString(), time: bar.startTime, barIndex: t, confirmedAt: at(t) };
    out.push({
      ...common,
      anchors: [...common.anchors, retestAnchor],
      patternInstanceId: 'pi_' + hashOf({ kind: 'price-action-retest', breakoutInstanceId: instanceId }).slice(0, 40),
      patternType: (up ? 'breakout_retest' : 'breakdown_retest') as PatternType,
      direction: up ? 'bullish' : 'bearish',
      status,
      firstSeenAt: at(t),
      confirmedAt: walk.holdAt !== null ? at(walk.holdAt) : null,
      resolvedAt: status === 'failed_breakout' ? at(walk.failedAt!) : null,
      confirmation: { ...breakoutConfirmation, confirmedByBarTime: walk.holdAt !== null ? view.bars[walk.holdAt]!.startTime : null },
      geometryMetrics: { ...common.geometryMetrics, retestBarsAfterBreakout: String(t - B) },
      patternLineage: { eventFamilyId, parentPatternInstanceId: instanceId, rootPatternInstanceId: instanceId, relationship: 'retest_of' },
    });
  }

  if (walk.failedAt !== null) {
    const f = walk.failedAt;
    out.push({
      ...common,
      patternInstanceId: 'pi_' + hashOf({ kind: 'price-action-false-break', breakoutInstanceId: instanceId }).slice(0, 40),
      patternType: (up ? 'false_breakout' : 'false_breakdown') as PatternType,
      direction: up ? 'bearish' : 'bullish',
      status: 'failed_breakout',
      firstSeenAt: at(f),
      confirmedAt: at(f),
      resolvedAt: at(f),
      confirmation: { direction: up ? ('down' as const) : ('up' as const), level: L.toString(), buffer: buf.toString(), confirmedByBarTime: view.bars[f]!.startTime },
      geometryMetrics: { ...common.geometryMetrics, barsAfterBreakout: String(f - B) },
      patternLineage: { eventFamilyId, parentPatternInstanceId: instanceId, rootPatternInstanceId: instanceId, relationship: 'false_break_of' },
    });
  }
  return out;
}

/**
 * The breakouts of the view, in bar order. For every decision bar B, the levels are the frame of bar B − 1. A resistance breakout needs the level above
 * the previous close and a final close above level plus buffer; a support breakdown is the mirror. One breakout event per structural lineage and
 * direction: a later re-cross of the same lineage is not a second breakout (docs/PATTERN_ENGINE_V1B.md §25.5).
 */
export function detectPriceAction(view: PitView, params: PatternParameters, atrs: ReadonlyArray<number | null>, frames: readonly (readonly FrameLevel[])[], ctx: PriceActionContext): PriceActionResult {
  const pa = params.priceAction;
  const last = view.bars.length - 1;
  const drafts: PriceActionDraft[] = [];
  const seen = new Set<string>();
  let levelEvaluations = 0;
  let barsWalked = 0;
  let breakoutCount = 0;
  for (let B = 1; B <= last; B++) {
    const A = scaleAt(view, atrs, params, B);
    if (A === null) continue;
    const prev = view.bars[B - 1]!.close;
    const close = view.bars[B]!.close;
    const buf = Decimal.from(pa.breakoutBufferAtr).times(A);
    const levels = frames[B - 1] ?? [];
    levelEvaluations++;
    for (const level of levels) {
      const L = level.priceLevel;
      let up: boolean;
      if (L.gt(prev) && close.gt(L.plus(buf))) up = true;
      else if (L.lt(prev) && close.lt(L.minus(buf))) up = false;
      else continue;
      const key = level.levelLineageId + (up ? ':up' : ':down');
      if (seen.has(key)) continue;
      seen.add(key);
      const walk = walkBreakout(view, pa, B, L, up, A, last);
      barsWalked += walk.barsWalked;
      drafts.push(...structuresOf(view, pa, ctx, level, B, up, A, last, walk));
      breakoutCount++;
    }
  }
  return { drafts, levelEvaluations, breakoutCount, barsWalked };
}
