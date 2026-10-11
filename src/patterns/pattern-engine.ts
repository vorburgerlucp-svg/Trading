// Pattern Engine (pattern-engine:v1b): the structural core and the price-action structures. It answers what geometry exists in the point-in-time
// final bars, whether it is forming, confirmed, target-active, completed, invalidated, failed, expired or outcome-ambiguous, and when NEXUS could
// first have known each state. It never produces a probability, a score, a statistic or a trade action. See docs/PATTERN_ENGINE_V1.md and
// docs/PATTERN_ENGINE_V1B.md.

import { MarketDataQualityService } from '../market-data/data-quality.js';
import { BAR_INTERVALS } from '../market-data/market-data-types.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { SUPPORT_RESISTANCE_VERSION } from '../quant/structure/support-resistance.js';
import type { ChartContext } from '../timeframes/chart-context.js';
import { detectCandidates, originalLine, spaceOf, swingsOf, atrSeriesOf, type Candidate } from './geometry.js';
import { linesStructuresIn, rectanglesIn } from './geometry-price-action.js';
import { swingInputsOf } from './levels.js';
import { walkCandidate, type WalkResult } from './lifecycle.js';
import { detectPriceAction, type PriceActionDraft } from './price-action.js';
import {
  ATR_VERSION,
  PATTERN_ENGINE_VERSION,
  PATTERN_GEOMETRY_VERSION,
  PATTERN_LIFECYCLE_VERSION,
  PRICE_ACTION_LIFECYCLE_VERSION,
  SWING_VERSION,
  V1B_IDENTITY,
  V1_IDENTITY,
  resolvePatternParameters,
  type PatternParameters,
} from './pattern-parameters.js';
import { PRICE_ACTION_TYPES, PatternError, type PatternDirection, type PatternObservation, type PatternRun, type PatternRunInput, type ReplayMode } from './pattern-types.js';
import { buildPitView, provenanceOf, type PitView } from './pit-view.js';

export type { PatternRunInput, PatternRun, PatternObservation } from './pattern-types.js';

export interface PatternRunOptions {
  /** Not part of the identity. Defaults to the epoch, so a run is reproducible. */
  createdAt?: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function validateInput(input: PatternRunInput): void {
  if (typeof input.instrument.instrumentId !== 'string' || input.instrument.instrumentId.trim() === '') throw new PatternError('PATTERN_INPUT_INVALID', 'instrumentId is required');
  if (!(BAR_INTERVALS as readonly string[]).includes(input.series.interval)) throw new PatternError('PATTERN_INPUT_INVALID', input.series.interval + ' is not a native interval');
  if (input.replay !== 'historical_research' && input.replay !== 'decision_time') throw new PatternError('PATTERN_INPUT_INVALID', 'replay must be historical_research or decision_time');
  if (!Array.isArray(input.bars)) throw new PatternError('PATTERN_INPUT_INVALID', 'bars must be an array');
}

/** A chart context is metadata. It must still belong to the same instrument, asOf, interval, series and replay: a mismatch is refused. */
function checkContext(ctx: ChartContext, input: PatternRunInput, asOf: string, useCase: string): void {
  const refuse = (message: string): never => {
    throw new PatternError('PATTERN_CONTEXT_MISMATCH', 'CHART_CONTEXT_MISMATCH: ' + message);
  };
  if (ctx.instrumentId !== input.instrument.instrumentId) refuse('instrument ' + ctx.instrumentId + ' differs from ' + input.instrument.instrumentId);
  if (parseUtc(ctx.asOf) !== parseUtc(asOf)) refuse('asOf ' + ctx.asOf + ' differs from ' + asOf);
  if (!ctx.timeframes[input.series.interval]) refuse('interval ' + input.series.interval + ' is not present in the context');
  if (!ctx.series) refuse('the context has no analytical basis');
  const s = ctx.series!;
  if (s.source !== input.series.source || s.session !== input.series.session || s.adjustment !== input.series.adjustment) refuse('source, session or adjustment differs');
  if (s.barReplay !== input.replay) refuse('replay ' + s.barReplay + ' differs from ' + input.replay);
  if (s.useCase !== useCase) refuse('use case ' + s.useCase + ' differs from ' + useCase);
}

const flip = (d: 'up' | 'down' | null, mirrored: boolean): 'up' | 'down' | null => (d === null || !mirrored ? d : d === 'up' ? 'down' : 'up');

interface RunCommon {
  instrumentId: string;
  interval: PatternRunInput['series']['interval'];
  series: PatternRun['series'];
  asOf: string;
  runId: string;
  runFingerprint: string;
  ctx: ChartContext | null;
}

function chartContextOf(ctx: ChartContext | null): PatternObservation['chartContext'] {
  return ctx === null ? null : { chartContextId: ctx.chartContextId, dominantTrend: ctx.dominantTrend, currentPhase: ctx.currentPhase, timeframeAlignment: ctx.timeframeAlignment.state };
}

/** The observation of one candidate at asOf. Prices and lines are mapped back to the original space. */
function observationOf(c: Candidate, walk: WalkResult, view: PitView, common: RunCommon): PatternObservation {
  const m = c.mirrored;
  const toOriginal = (d: Decimal) => (m ? d.negated() : d);
  const anchors = c.anchors.map((a) => ({
    role: a.role,
    kind: m ? (a.kind === 'high' ? ('low' as const) : ('high' as const)) : a.kind,
    price: toOriginal(a.price).toString(),
    time: view.bars[a.index]!.startTime,
    barIndex: a.index,
    confirmedAt: view.bars[a.confirmedIndex]!.instant,
  }));
  // The identity tags are frozen per family: V1 ids keep the V1 tags, so a version bump never changes them (docs/PATTERN_ENGINE_V1B.md §2).
  const tags = PRICE_ACTION_TYPES.has(c.patternType) ? V1B_IDENTITY : V1_IDENTITY;
  const patternInstanceId =
    'pi_' +
    hashOf({
      kind: 'pattern-instance',
      engine: tags.engine,
      geometry: tags.geometry,
      instrumentId: common.instrumentId,
      interval: common.interval,
      patternType: c.patternType,
      anchors: anchors.map((a) => [a.role, a.kind, a.time, a.price]),
    }).slice(0, 40);
  const direction: PatternDirection = c.direction === 'neutral' ? (flip(walk.confirmDirection, m) === 'up' ? 'bullish' : flip(walk.confirmDirection, m) === 'down' ? 'bearish' : 'neutral') : c.direction;
  const confirmedDirection = flip(walk.confirmDirection, m);
  const status = walk.status;
  const patternObservationId = 'po_' + hashOf({ kind: 'pattern-observation', patternInstanceId, asOf: common.asOf, status, inputFingerprint: common.runFingerprint }).slice(0, 40);
  const boundaries: PatternObservation['boundaries'] = {};
  for (const [name, line] of Object.entries(c.lines)) {
    const o = originalLine(line, m);
    boundaries[name] = { intercept: o.a.toString(), slope: o.b.toString() };
  }
  return {
    patternInstanceId,
    patternObservationId,
    patternType: c.patternType,
    direction,
    status,
    instrumentId: common.instrumentId,
    interval: common.interval,
    series: common.series,
    asOf: common.asOf,
    firstSeenAt: view.bars[c.geometryKnownIndex]!.instant,
    confirmedAt: walk.confirmIndex === null ? null : view.bars[walk.confirmIndex]!.instant,
    invalidatedAt: walk.invalidatedIndex === null ? null : view.bars[walk.invalidatedIndex]!.instant,
    resolvedAt: walk.resolvedIndex === null ? null : view.bars[walk.resolvedIndex]!.instant,
    anchors,
    confirmation: {
      direction: confirmedDirection,
      level: walk.confirmLevel === null ? null : toOriginal(walk.confirmLevel).toString(),
      buffer: c.breakoutBuffer.toString(),
      confirmedByBarTime: walk.confirmIndex === null ? null : view.bars[walk.confirmIndex]!.startTime,
    },
    invalidation: { rule: c.invalidationRule, level: toOriginal(c.invalidationLevel).toString() },
    target: {
      method: c.targetMethod,
      price: walk.confirmDirection !== null && walk.confirmIndex !== null ? toOriginal(c.targetAt(walk.confirmDirection, walk.confirmIndex)).toString() : null,
    },
    boundaries,
    geometryMetrics: c.metrics,
    chartContext: chartContextOf(common.ctx),
    evidenceRefs: { patternRunId: common.runId, chartContextId: common.ctx === null ? null : common.ctx.chartContextId },
  };
}

/** A price-action draft at asOf: the same per-asOf identity and metadata as a candidate observation. */
function finalizeDraft(d: PriceActionDraft, common: RunCommon): PatternObservation {
  const patternObservationId = 'po_' + hashOf({ kind: 'pattern-observation', patternInstanceId: d.patternInstanceId, asOf: common.asOf, status: d.status, inputFingerprint: common.runFingerprint }).slice(0, 40);
  return {
    ...d,
    patternObservationId,
    instrumentId: common.instrumentId,
    interval: common.interval,
    series: common.series,
    asOf: common.asOf,
    chartContext: chartContextOf(common.ctx),
    evidenceRefs: { patternRunId: common.runId, chartContextId: common.ctx === null ? null : common.ctx.chartContextId },
  };
}

/**
 * Runs the pattern engine on one series at one asOf. The bars are never trusted: the engine builds its own point-in-time view. An unproven
 * decision-time bar throws; an invalid series returns INVALID_DATA with its issues and no geometry.
 */
export function runPatternEngine(input: PatternRunInput, options: PatternRunOptions = {}): PatternRun {
  validateInput(input);
  const asOf = toUtcIso(parseUtc(input.asOf));
  const params: PatternParameters = resolvePatternParameters(input.parameters);
  const useCase = input.useCase ?? 'analysis';
  const view = buildPitView(input.bars, asOf, input.replay as ReplayMode);
  const ctx = input.chartContext ?? null;
  if (ctx !== null) checkContext(ctx, input, asOf, useCase);

  const quality = new MarketDataQualityService().assessBars(
    view.bars.map((p) => p.bar),
    {
      instrument: { instrumentId: input.instrument.instrumentId, assetClass: input.instrument.assetClass as never, allowsNegativePrices: input.instrument.allowsNegativePrices },
      calendar: input.calendar,
      interval: input.series.interval,
      session: input.series.session,
      adjustment: input.series.adjustment,
      source: input.series.source,
      asOf,
      useCase,
      ...(input.sourceInfo !== undefined ? { sourceInfo: input.sourceInfo } : {}),
    },
  );
  const issues: PatternRun['issues'] = quality.issues.map((i) => ({ code: i.code, message: i.message }));
  if (view.unrepresentable > 0) issues.push({ code: 'price_not_representable', message: view.unrepresentable + ' bar(s) have a price that does not survive a double; swing detection would compare rounded values' });
  const invalid = !quality.valid || view.unrepresentable > 0;
  const insufficient = !invalid && params.tolerance.mode === 'atr' && view.bars.length < params.tolerance.atrPeriod + 1;
  const status: PatternRun['status'] = invalid ? 'INVALID_DATA' : insufficient ? 'INSUFFICIENT_DATA' : 'READY';
  const computable = !invalid && !insufficient;

  const inputFingerprint = hashOf({
    engine: PATTERN_ENGINE_VERSION,
    geometry: PATTERN_GEOMETRY_VERSION,
    lifecycle: PATTERN_LIFECYCLE_VERSION,
    priceActionLifecycle: PRICE_ACTION_LIFECYCLE_VERSION,
    supportResistance: SUPPORT_RESISTANCE_VERSION,
    swing: SWING_VERSION,
    atr: ATR_VERSION,
    instrument: { instrumentId: input.instrument.instrumentId, assetClass: input.instrument.assetClass, tickSize: input.instrument.tickSize ?? null, allowsNegativePrices: input.instrument.allowsNegativePrices },
    series: input.series,
    asOf,
    replay: input.replay,
    useCase,
    parameters: params,
    bars: view.bars.map((p) => p.bar),
    chartContext: ctx === null ? null : { chartContextId: ctx.chartContextId, inputFingerprint: ctx.inputFingerprint },
  });
  const patternRunId = 'pr_' + inputFingerprint.slice(0, 40);
  const common: RunCommon = { instrumentId: input.instrument.instrumentId, interval: input.series.interval, series: { ...input.series }, asOf, runId: patternRunId, runFingerprint: inputFingerprint, ctx };

  const byInstance = new Map<string, PatternObservation>();
  const diagnostics = { swings: 0, candidates: 0, barsWalked: 0, levelEvaluations: 0, breakoutCount: 0, priceActionBarsWalked: 0, rectangleBirthChecks: 0, channelWedgeWindows: 0 };
  if (computable) {
    const atrs = atrSeriesOf(view, params.tolerance.atrPeriod);
    const real = spaceOf(view, false);
    const mirror = spaceOf(view, true);
    const realSwings = swingsOf(real, params.swing.leftBars, params.swing.rightBars);
    diagnostics.swings = realSwings.length;
    const last = view.bars.length - 1;

    // V1 structures: unchanged (docs/PATTERN_ENGINE_V1B.md §1).
    const detection = detectCandidates(view, params);
    const candidates: Candidate[] = [...detection.candidates];

    // V1B geometry: rectangles from support/resistance clusters, channels and wedges from fitted swing windows (real space only: their mirror
    // images are the other channel or wedge type, so the real space covers both).
    const levelInputs = swingInputsOf(view, realSwings);
    const rect = rectanglesIn(view, params, atrs, levelInputs);
    const lines = linesStructuresIn(view, params, atrs, realSwings);
    diagnostics.rectangleBirthChecks = rect.births;
    diagnostics.channelWedgeWindows = lines.channelWedgeWindows;
    candidates.push(...rect.candidates, ...lines.candidates);

    for (const c of candidates) {
      const walk = walkCandidate(c, c.mirrored ? mirror : real, last);
      diagnostics.barsWalked += walk.barsWalked;
      const observation = observationOf(c, walk, view, common);
      if (!byInstance.has(observation.patternInstanceId)) byInstance.set(observation.patternInstanceId, observation);
    }
    diagnostics.candidates = candidates.length;

    // V1B price action: breakouts, retests and false breaks.
    const pa = detectPriceAction(view, params, atrs, levelInputs, { instrumentId: input.instrument.instrumentId, interval: input.series.interval, series: { ...input.series } });
    diagnostics.levelEvaluations = pa.levelEvaluations;
    diagnostics.breakoutCount = pa.breakoutCount;
    diagnostics.priceActionBarsWalked = pa.barsWalked;
    for (const d of pa.drafts) {
      const observation = finalizeDraft(d, common);
      if (!byInstance.has(observation.patternInstanceId)) byInstance.set(observation.patternInstanceId, observation);
    }
  }
  const observations = [...byInstance.values()].sort((a, b) => (a.patternInstanceId < b.patternInstanceId ? -1 : a.patternInstanceId > b.patternInstanceId ? 1 : 0));
  const run: PatternRun = {
    patternRunId,
    inputFingerprint,
    engineVersion: PATTERN_ENGINE_VERSION,
    geometryVersion: PATTERN_GEOMETRY_VERSION,
    lifecycleVersion: PATTERN_LIFECYCLE_VERSION,
    priceActionLifecycleVersion: PRICE_ACTION_LIFECYCLE_VERSION,
    supportResistanceVersion: SUPPORT_RESISTANCE_VERSION,
    swingVersion: SWING_VERSION,
    atrVersion: ATR_VERSION,
    instrumentId: input.instrument.instrumentId,
    series: { ...input.series },
    asOf,
    replayMode: input.replay as ReplayMode,
    status,
    inputStart: view.bars[0]?.startTime ?? null,
    inputEnd: view.bars[view.bars.length - 1]?.startTime ?? null,
    barCount: view.bars.length,
    provenance: provenanceOf(view),
    chartContextRef: ctx === null ? null : { chartContextId: ctx.chartContextId, inputFingerprint: ctx.inputFingerprint },
    parameters: params,
    observations,
    issues,
    diagnostics: {
      pitBarCount: view.bars.length,
      swingCount: diagnostics.swings,
      candidateCount: diagnostics.candidates,
      barsWalked: diagnostics.barsWalked,
      levelEvaluations: diagnostics.levelEvaluations,
      breakoutCount: diagnostics.breakoutCount,
      priceActionBarsWalked: diagnostics.priceActionBarsWalked,
      rectangleBirthChecks: diagnostics.rectangleBirthChecks,
      channelWedgeWindows: diagnostics.channelWedgeWindows,
    },
    createdAt: options.createdAt ?? '1970-01-01T00:00:00.000Z',
  };
  return deepFreeze(run);
}
