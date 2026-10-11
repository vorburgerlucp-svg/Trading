// Pattern Engine V1 (pattern-engine:v1): the structural core. It answers what geometry exists in the point-in-time final bars, whether it is
// forming, confirmed, target-active, completed, invalidated, failed, expired or outcome-ambiguous, and when NEXUS could first have known each
// state. It never produces a probability, a score, a statistic or a trade action. See docs/PATTERN_ENGINE_V1.md.

import { MarketDataQualityService } from '../market-data/data-quality.js';
import { BAR_INTERVALS } from '../market-data/market-data-types.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import { hashOf } from '../persistence/canonical-json.js';
import { ATR_VERSION, SWING_VERSION, PATTERN_ENGINE_VERSION, PATTERN_GEOMETRY_VERSION, PATTERN_LIFECYCLE_VERSION, resolvePatternParameters, type PatternParameters } from './pattern-parameters.js';
import { detectCandidates, originalLine, spaceOf, type Candidate } from './geometry.js';
import { walkCandidate, type WalkResult } from './lifecycle.js';
import { buildPitView, provenanceOf, type PitView } from './pit-view.js';
import { PatternError, type PatternDirection, type PatternObservation, type PatternRun, type PatternRunInput, type ReplayMode } from './pattern-types.js';
import type { ChartContext } from '../timeframes/chart-context.js';

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
  if (!BAR_INTERVALS.includes(input.series.interval)) throw new PatternError('PATTERN_INPUT_INVALID', input.series.interval + ' is not a native interval');
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

/** The observation of one candidate at asOf. Prices and lines are mapped back to the original space. */
function observationOf(
  c: Candidate,
  walk: WalkResult,
  view: PitView,
  common: { instrumentId: string; interval: PatternRunInput['series']['interval']; series: PatternRun['series']; asOf: string; runId: string; runFingerprint: string; ctx: ChartContext | null },
): PatternObservation {
  const m = c.mirrored;
  const toOriginal = (d: import('../money/decimal.js').Decimal) => (m ? d.negated() : d);
  const anchors = c.anchors.map((a) => ({
    role: a.role,
    kind: m ? (a.kind === 'high' ? ('low' as const) : ('high' as const)) : a.kind,
    price: toOriginal(a.price).toString(),
    time: view.bars[a.index]!.startTime,
    barIndex: a.index,
    confirmedAt: view.bars[a.confirmedIndex]!.instant,
  }));
  const patternInstanceId =
    'pi_' +
    hashOf({
      kind: 'pattern-instance',
      engine: PATTERN_ENGINE_VERSION,
      geometry: PATTERN_GEOMETRY_VERSION,
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
  const ctx = common.ctx;
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
    chartContext: ctx === null ? null : { chartContextId: ctx.chartContextId, dominantTrend: ctx.dominantTrend, currentPhase: ctx.currentPhase, timeframeAlignment: ctx.timeframeAlignment.state },
    evidenceRefs: { patternRunId: common.runId, chartContextId: ctx === null ? null : ctx.chartContextId },
  };
}

/**
 * Runs the structural pattern engine on one series at one asOf. The bars are never trusted: the engine builds its own point-in-time view. An
 * unproven decision-time bar throws; an invalid series returns INVALID_DATA with its issues and no geometry.
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

  const detection = invalid || insufficient ? { candidates: [] as Candidate[], diagnostics: { swings: 0, candidates: 0, rejectedNoScale: 0 } } : detectCandidates(view, params);

  const inputFingerprint = hashOf({
    engine: PATTERN_ENGINE_VERSION,
    geometry: PATTERN_GEOMETRY_VERSION,
    lifecycle: PATTERN_LIFECYCLE_VERSION,
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

  const real = invalid || insufficient ? null : spaceOf(view, false);
  const mirror = invalid || insufficient ? null : spaceOf(view, true);
  const common = { instrumentId: input.instrument.instrumentId, interval: input.series.interval, series: { ...input.series }, asOf, runId: patternRunId, runFingerprint: inputFingerprint, ctx };
  const byInstance = new Map<string, PatternObservation>();
  let barsWalked = 0;
  if (real !== null && mirror !== null) {
    const last = view.bars.length - 1;
    for (const c of detection.candidates) {
      const walk = walkCandidate(c, c.mirrored ? mirror : real, last);
      barsWalked += walk.barsWalked;
      const observation = observationOf(c, walk, view, common);
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
    diagnostics: { pitBarCount: view.bars.length, swingCount: detection.diagnostics.swings, candidateCount: detection.candidates.length, barsWalked },
    createdAt: options.createdAt ?? '1970-01-01T00:00:00.000Z',
  };
  return deepFreeze(run);
}
