// Multi-timeframe / whole-chart context V1 (chart-context-engine:v1). Read docs/MULTITIMEFRAME_CHART_CONTEXT_V1.md first.
//
// It consumes verified QuantRunRecords from quant-engine:v3 and arranges their deterministic outputs. It recomputes nothing: no indicator,
// no swing, no level, no structure. It describes the market at one asOf. It never produces an order, a probability, a pattern or an AI
// opinion. Every input is verified, and any unverified, incoherent, duplicate or unknown input is refused (fail closed).

import { BAR_INTERVALS, type BarInterval } from '../market-data/market-data-types.js';
import { parseUtc, toUtcIso } from '../market-data/time.js';
import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { QUANT_ENGINE_VERSION } from '../quant/quant-engine.js';
import { verifyRunRecord } from '../quant/quant-run-store.js';
import type { QuantBarProvenance, QuantResult, QuantRunRecord } from '../quant/quant-types.js';
import type { StructureTrend } from '../quant/structure/market-structure.js';
import { ALIGNMENT_VERSION, alignmentOf, phaseOf, type AlignmentState, type LayerTrend, type PhaseState } from './alignment.js';
import { DEFAULT_HIERARCHY, HIERARCHY_LAYERS, TIMEFRAME_HIERARCHY_VERSION, assertHierarchy, type HierarchyLayer, type HierarchyMap } from './timeframe-hierarchy.js';

export const CHART_CONTEXT_ENGINE_VERSION = 'chart-context-engine:v1';

/** The Quant Engine versions this context understands. Anything else is refused, never consumed silently. */
export const SUPPORTED_QUANT_ENGINE_VERSIONS: readonly string[] = Object.freeze([QUANT_ENGINE_VERSION]);

/** The intervals whose structural levels are "major" context. Every other interval's levels are preserved as "minor". */
const MAJOR_LEVEL_INTERVALS: readonly BarInterval[] = Object.freeze(['1d', '4h']);

/** Higher timeframes first. Used for deterministic ordering only, never as a weight. */
const INTERVAL_RANK: Readonly<Record<BarInterval, number>> = Object.freeze({ '1d': 0, '4h': 1, '1h': 2, '15m': 3, '5m': 4, '1m': 5 });

/** The order in which the dominant trend is searched: the highest available structural layer first. */
const DOMINANCE_ORDER: readonly HierarchyLayer[] = Object.freeze(['POSITION', 'SWING', 'INTRADAY', 'MICRO']);

export type ChartContextErrorCode =
  | 'CHART_INPUT_INVALID'
  | 'CHART_POLICY_INVALID'
  | 'CHART_QUANT_UNVERIFIED'
  | 'CHART_ENGINE_UNSUPPORTED'
  | 'CHART_IN_PROGRESS_REFUSED'
  | 'CHART_NOT_NATIVE'
  | 'CHART_INPUT_MISMATCH'
  | 'CHART_DUPLICATE_INTERVAL'
  | 'CHART_INTERVAL_NOT_REQUESTED'
  | 'CHART_STRUCTURE_INCONSISTENT';

export class ChartContextError extends Error {
  override readonly name = 'ChartContextError';
  constructor(
    readonly code: ChartContextErrorCode,
    message: string,
  ) {
    super(code + ': ' + message);
  }
}

export interface ChartContextInput {
  instrumentId: string;
  /** The single decision instant every run must share. */
  asOf: string;
  /** Stated explicitly by the caller. A requested interval with no run is a gap in coverage, not an error. */
  requestedIntervals: readonly BarInterval[];
  runs: readonly QuantRunRecord[];
}

/** The hierarchy policy. Part of the context identity: a different policy is a different context. */
export interface ChartContextPolicy {
  hierarchy: HierarchyMap;
}

export type TimeframeStatus = 'READY' | 'INSUFFICIENT_DATA' | 'INVALID_DATA';

export interface TimeframeState {
  interval: BarInterval;
  quantRunId: string;
  quantResultHash: string;
  status: TimeframeStatus;
  inputStart: string | null;
  inputEnd: string | null;
  barCount: number;
  structure: { trend: StructureTrend; lastHighLabel: string | null; lastLowLabel: string | null; reason: string };
  /** Raw Quant values. Never converted into a bullish or bearish verdict. */
  momentum: { rsi: unknown; macd: unknown };
  /** The raw ADX value, which carries +DI and −DI. */
  trendStrength: { adx: unknown };
  volatility: { atr: unknown; bollinger: unknown };
  levels: { nearestSupport: unknown; nearestResistance: unknown; pivots: unknown };
  provenance: QuantBarProvenance & { barReplay: string };
}

export interface LayerState {
  layer: HierarchyLayer;
  state: LayerTrend;
  intervals: BarInterval[];
  /** Usable intervals (READY with a confirmed trend), in hierarchy order. Every interval stays visible here. */
  contributing: Array<{ interval: BarInterval; trend: StructureTrend }>;
  /** Intervals that do not count, with the reason. */
  unusable: Array<{ interval: BarInterval; reason: 'missing' | 'invalid_data' | 'insufficient_data' | 'structure_unknown' }>;
  reason: string;
}

export interface ContextLevel {
  interval: BarInterval;
  kind: 'support' | 'resistance';
  /** The exact decimal price of the Quant level. Nearby levels are never merged here. */
  price: string;
  touchCount: number;
  firstSeen: string;
  lastSeen: string;
  confirmedAt: string;
  /** The Quant strength score, carried raw. Not a probability. */
  strengthScore: number;
  sourceQuantRunId: string;
  sourceResultHash: string;
}

export interface ChartContext {
  chartContextId: string;
  engineVersion: typeof CHART_CONTEXT_ENGINE_VERSION;
  hierarchyVersion: typeof TIMEFRAME_HIERARCHY_VERSION;
  alignmentVersion: typeof ALIGNMENT_VERSION;
  instrumentId: string;
  asOf: string;
  requestedIntervals: BarInterval[];
  /** The one analytical basis every run shares. null when no run was supplied. */
  series: { source: string; session: string; adjustment: string; barReplay: string; useCase: string } | null;
  timeframes: Partial<Record<BarInterval, TimeframeState>>;
  layers: Record<HierarchyLayer, LayerState>;
  timeframeAlignment: { state: AlignmentState; inputs: { position: LayerTrend; swing: LayerTrend; intraday: LayerTrend } };
  currentPhase: PhaseState;
  dominantTrend: { trend: StructureTrend; sourceLayer: HierarchyLayer | null; reason: string };
  secularTrend: { status: 'unavailable'; reason: string };
  majorSupport: ContextLevel[];
  majorResistance: ContextLevel[];
  minorSupport: ContextLevel[];
  minorResistance: ContextLevel[];
  coverage: {
    requestedIntervals: BarInterval[];
    readyIntervals: BarInterval[];
    missingIntervals: BarInterval[];
    invalidIntervals: BarInterval[];
    insufficientIntervals: BarInterval[];
    complete: boolean;
  };
  provenance: {
    decisionTimeKnowledgeProven: boolean;
    historicalReconstruction: boolean;
    legacyUnproven: boolean;
    allSignalBarsContemporaneous: boolean;
    perTimeframe: Partial<Record<BarInterval, { decisionTimeKnowledgeProven: boolean; historicalReconstruction: boolean; legacyUnproven: boolean; latestFinalBarContemporaneous: boolean }>>;
  };
  quality: { dataValid: boolean; contextComplete: boolean };
  inputFingerprint: string;
}

function fail(code: ChartContextErrorCode, message: string): never {
  throw new ChartContextError(code, message);
}

/** Copies a Quant value into plain data: Decimal becomes its exact decimal string, and nothing is shared with the caller. */
function plain(value: unknown): unknown {
  if (value instanceof Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = plain(v);
    return out;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** The structure must agree with its own labels. A corrupted structure whose hash was recomputed still fails here. */
function assertStructure(run: QuantRunRecord): void {
  const s = run.result.marketStructure;
  const h = s.lastHighLabel;
  const l = s.lastLowLabel;
  const expected: StructureTrend = h === null || l === null ? 'unknown' : h === 'HH' && l === 'HL' ? 'bullish' : h === 'LH' && l === 'LL' ? 'bearish' : 'range';
  const label = run.result.quantRunId;
  if (s.trend !== expected) fail('CHART_STRUCTURE_INCONSISTENT', label + ': trend ' + s.trend + ' does not follow from its labels (' + h + ' / ' + l + ')');
  if (h !== null && !['HH', 'LH', 'EH'].includes(h)) fail('CHART_STRUCTURE_INCONSISTENT', label + ': high label ' + h + ' is not a high label');
  if (l !== null && !['HL', 'LL', 'EL'].includes(l)) fail('CHART_STRUCTURE_INCONSISTENT', label + ': low label ' + l + ' is not a low label');
  if (s.points.length > 0) {
    const lastHigh = [...s.points].reverse().find((p) => p.kind === 'high');
    const lastLow = [...s.points].reverse().find((p) => p.kind === 'low');
    if (lastHigh && lastHigh.label !== h) fail('CHART_STRUCTURE_INCONSISTENT', label + ': last high point disagrees with the high label');
    if (lastLow && lastLow.label !== l) fail('CHART_STRUCTURE_INCONSISTENT', label + ': last low point disagrees with the low label');
  }
}

/** Verifies one input record: its hash, its engine, its mode, its interval, its identity and its structure. */
function verifyInput(record: QuantRunRecord, instrumentId: string, asOf: string, requested: readonly BarInterval[]): QuantRunRecord {
  try {
    verifyRunRecord(record);
  } catch (error) {
    fail('CHART_QUANT_UNVERIFIED', error instanceof Error ? error.message : 'the record cannot be verified');
  }
  const r = record.result;
  if (!SUPPORTED_QUANT_ENGINE_VERSIONS.includes(r.engineVersion)) fail('CHART_ENGINE_UNSUPPORTED', r.quantRunId + ' was produced by ' + r.engineVersion + ', which this context does not understand');
  if (r.mode !== 'final_only') fail('CHART_IN_PROGRESS_REFUSED', r.quantRunId + ' is ' + r.mode + '; the context is final-only');
  if (!BAR_INTERVALS.includes(r.series.interval)) fail('CHART_NOT_NATIVE', r.quantRunId + ' is on ' + r.series.interval + ', which is not a native interval');
  if (r.quantRunId !== 'qr_' + r.inputFingerprint.slice(0, 40)) fail('CHART_QUANT_UNVERIFIED', r.quantRunId + ' does not derive from its input fingerprint');
  assertStructure(record);
  if (r.instrumentId !== instrumentId) fail('CHART_INPUT_MISMATCH', r.quantRunId + ' is for ' + r.instrumentId + ', the context is for ' + instrumentId);
  if (parseUtc(r.asOf) !== parseUtc(asOf)) fail('CHART_INPUT_MISMATCH', r.quantRunId + ' has asOf ' + r.asOf + ', the context has ' + asOf);
  if (!requested.includes(r.series.interval)) fail('CHART_INTERVAL_NOT_REQUESTED', r.quantRunId + ' is on ' + r.series.interval + ', which was not requested');
  return record;
}

function normalizeRequested(requested: readonly BarInterval[]): BarInterval[] {
  const seen = new Set<BarInterval>();
  for (const interval of requested) {
    if (!BAR_INTERVALS.includes(interval)) fail('CHART_NOT_NATIVE', interval + ' is not a native interval');
    if (seen.has(interval)) fail('CHART_INPUT_INVALID', interval + ' is requested twice');
    seen.add(interval);
  }
  return [...requested].sort((a, b) => BAR_INTERVALS.indexOf(a) - BAR_INTERVALS.indexOf(b));
}

function warmupIncomplete(r: QuantResult): boolean {
  return Object.values(r.warmupStatus).some((w) => !w.ready);
}

function timeframeOf(record: QuantRunRecord): TimeframeState {
  const r = record.result;
  const status: TimeframeStatus = !r.dataQuality.valid ? 'INVALID_DATA' : warmupIncomplete(r) ? 'INSUFFICIENT_DATA' : 'READY';
  const ready = status === 'READY';
  const s = r.marketStructure;
  return {
    interval: r.series.interval,
    quantRunId: r.quantRunId,
    quantResultHash: record.resultHash,
    status,
    inputStart: r.inputStart,
    inputEnd: r.inputEnd,
    barCount: r.barCount,
    structure: {
      trend: ready ? s.trend : 'unknown',
      lastHighLabel: ready ? s.lastHighLabel : null,
      lastLowLabel: ready ? s.lastLowLabel : null,
      reason: status === 'INVALID_DATA' ? 'data invalid' : status === 'INSUFFICIENT_DATA' ? 'warm-up not complete' : s.reason,
    },
    momentum: { rsi: plain(r.indicators.rsi), macd: plain(r.indicators.macd) },
    trendStrength: { adx: plain(r.indicators.adx) },
    volatility: { atr: plain(r.indicators.atr), bollinger: plain(r.indicators.bollinger) },
    levels: { nearestSupport: plain(r.supportResistance.nearestSupport ?? null), nearestResistance: plain(r.supportResistance.nearestResistance ?? null), pivots: plain(r.pivots) },
    provenance: { ...(plain(r.barDataProvenance) as QuantBarProvenance), barReplay: r.barReplay },
  };
}

function layerStateOf(layer: HierarchyLayer, states: Map<BarInterval, TimeframeState>, requested: readonly BarInterval[], hierarchy: HierarchyMap): LayerState {
  const intervals = hierarchy[layer].filter((i) => requested.includes(i));
  if (layer === 'STRATEGIC' && intervals.length === 0) {
    return { layer, state: 'unavailable', intervals: [], contributing: [], unusable: [], reason: 'weekly and monthly timeframes are not implemented in V1' };
  }
  const contributing: LayerState['contributing'] = [];
  const unusable: LayerState['unusable'] = [];
  let anyReady = false;
  for (const interval of intervals) {
    const st = states.get(interval);
    if (!st) {
      unusable.push({ interval, reason: 'missing' });
      continue;
    }
    if (st.status === 'INVALID_DATA') {
      unusable.push({ interval, reason: 'invalid_data' });
      continue;
    }
    if (st.status === 'INSUFFICIENT_DATA') {
      unusable.push({ interval, reason: 'insufficient_data' });
      continue;
    }
    anyReady = true;
    if (st.structure.trend === 'unknown') {
      unusable.push({ interval, reason: 'structure_unknown' });
      continue;
    }
    contributing.push({ interval, trend: st.structure.trend });
  }
  if (contributing.length === 0) {
    const state: LayerTrend = anyReady ? 'unknown' : 'unavailable';
    return { layer, state, intervals, contributing, unusable, reason: anyReady ? 'no interval has a confirmed structure' : 'no usable interval' };
  }
  const trends = new Set(contributing.map((c) => c.trend));
  const state: LayerTrend = trends.size === 1 ? (contributing[0]!.trend as LayerTrend) : 'mixed';
  const reason = state === 'mixed' ? 'usable intervals disagree: ' + contributing.map((c) => c.interval + ' ' + c.trend).join(', ') : 'usable intervals agree';
  return { layer, state, intervals, contributing, unusable, reason };
}

function dominantOf(layers: Record<HierarchyLayer, LayerState>): ChartContext['dominantTrend'] {
  for (const layer of DOMINANCE_ORDER) {
    const s = layers[layer].state;
    if (s === 'unknown' || s === 'unavailable') continue;
    if (s === 'mixed') return { trend: 'unknown', sourceLayer: layer, reason: 'higher layer is mixed: a lower timeframe does not override it' };
    return { trend: s, sourceLayer: layer, reason: 'highest available structural layer' };
  }
  return { trend: 'unknown', sourceLayer: null, reason: 'no layer has a confirmed structure' };
}

function levelsOf(records: QuantRunRecord[], states: Map<BarInterval, TimeframeState>): Pick<ChartContext, 'majorSupport' | 'majorResistance' | 'minorSupport' | 'minorResistance'> {
  const out = { majorSupport: [] as ContextLevel[], majorResistance: [] as ContextLevel[], minorSupport: [] as ContextLevel[], minorResistance: [] as ContextLevel[] };
  for (const record of records) {
    const r = record.result;
    const interval = r.series.interval;
    // Levels of a run whose data is invalid are not context. They are never copied into the chart.
    if (states.get(interval)?.status === 'INVALID_DATA' || r.supportResistance.status !== 'ok') continue;
    const major = MAJOR_LEVEL_INTERVALS.includes(interval);
    for (const level of r.supportResistance.levels) {
      const entry: ContextLevel = {
        interval,
        kind: level.kind,
        price: level.priceLevel.toString(),
        touchCount: level.touchCount,
        firstSeen: level.firstSeen,
        lastSeen: level.lastSeen,
        confirmedAt: level.confirmedAt,
        strengthScore: level.strengthScore,
        sourceQuantRunId: r.quantRunId,
        sourceResultHash: record.resultHash,
      };
      const bucket = major ? (level.kind === 'support' ? out.majorSupport : out.majorResistance) : level.kind === 'support' ? out.minorSupport : out.minorResistance;
      bucket.push(entry);
    }
  }
  const order = (a: ContextLevel, b: ContextLevel) => INTERVAL_RANK[a.interval] - INTERVAL_RANK[b.interval] || Decimal.from(a.price).cmp(Decimal.from(b.price));
  return {
    majorSupport: out.majorSupport.sort(order),
    majorResistance: out.majorResistance.sort(order),
    minorSupport: out.minorSupport.sort(order),
    minorResistance: out.minorResistance.sort(order),
  };
}

/**
 * Builds the whole-chart context of one instrument at one asOf from verified Quant runs. Fails closed on any input it cannot verify or
 * that is incoherent. A missing requested interval is a gap in coverage, and the context is still computed.
 */
export function buildChartContext(input: ChartContextInput, policy: ChartContextPolicy = { hierarchy: DEFAULT_HIERARCHY }): ChartContext {
  assertHierarchy(policy.hierarchy);
  if (typeof input.instrumentId !== 'string' || input.instrumentId.trim() === '') fail('CHART_INPUT_INVALID', 'instrumentId is required');
  let asOf: string;
  try {
    asOf = toUtcIso(parseUtc(input.asOf));
  } catch {
    fail('CHART_INPUT_INVALID', 'asOf is not a valid instant');
  }
  const requested = normalizeRequested(input.requestedIntervals);
  const records = input.runs.map((run) => verifyInput(run, input.instrumentId, asOf, requested));

  const byInterval = new Map<BarInterval, QuantRunRecord>();
  for (const record of records) {
    const interval = record.result.series.interval;
    if (byInterval.has(interval)) fail('CHART_DUPLICATE_INTERVAL', 'two runs are on ' + interval + '; one run per interval is required');
    byInterval.set(interval, record);
  }
  const ordered = [...byInterval.values()].sort((a, b) => BAR_INTERVALS.indexOf(a.result.series.interval) - BAR_INTERVALS.indexOf(b.result.series.interval));
  const first = ordered[0];
  if (first) {
    const basis = first.result;
    for (const record of ordered.slice(1)) {
      const r = record.result;
      const field = (name: string, a: unknown, b: unknown) => {
        if (a !== b) fail('CHART_INPUT_MISMATCH', 'runs disagree on ' + name + ': ' + String(a) + ' against ' + String(b) + ' (' + basis.quantRunId + ' and ' + r.quantRunId + ')');
      };
      field('source', basis.series.source, r.series.source);
      field('session', basis.series.session, r.series.session);
      field('adjustment', basis.series.adjustment, r.series.adjustment);
      field('barReplay', basis.barReplay, r.barReplay);
      field('useCase', basis.useCase, r.useCase);
    }
  }

  const states = new Map<BarInterval, TimeframeState>();
  for (const record of ordered) states.set(record.result.series.interval, timeframeOf(record));
  const timeframes: Partial<Record<BarInterval, TimeframeState>> = {};
  for (const interval of requested) {
    const st = states.get(interval);
    if (st) timeframes[interval] = st;
  }

  const layers = {} as Record<HierarchyLayer, LayerState>;
  for (const layer of HIERARCHY_LAYERS) layers[layer] = layerStateOf(layer, states, requested, policy.hierarchy);

  const position = layers.POSITION.state;
  const swing = layers.SWING.state;
  const intraday = layers.INTRADAY.state;
  const alignment = alignmentOf(position, swing, intraday);
  const dominant = dominantOf(layers);
  const levels = levelsOf(ordered, states);

  const readyIntervals = requested.filter((i) => states.get(i)?.status === 'READY');
  const invalidIntervals = requested.filter((i) => states.get(i)?.status === 'INVALID_DATA');
  const insufficientIntervals = requested.filter((i) => states.get(i)?.status === 'INSUFFICIENT_DATA');
  const missingIntervals = requested.filter((i) => !states.has(i));
  const complete = requested.length > 0 && readyIntervals.length === requested.length;

  const perTimeframe: ChartContext['provenance']['perTimeframe'] = {};
  for (const record of ordered) {
    const p = record.result.barDataProvenance;
    perTimeframe[record.result.series.interval] = {
      decisionTimeKnowledgeProven: p.decisionTimeKnowledgeProven,
      historicalReconstruction: p.historicalReconstruction,
      legacyUnproven: p.legacyUnproven,
      latestFinalBarContemporaneous: p.latestFinalBarContemporaneous,
    };
  }

  const inputs = ordered.map((record) => ({ interval: record.result.series.interval, quantRunId: record.result.quantRunId, quantResultHash: record.resultHash }));
  const inputFingerprint = hashOf({
    engine: CHART_CONTEXT_ENGINE_VERSION,
    hierarchyVersion: TIMEFRAME_HIERARCHY_VERSION,
    alignmentVersion: ALIGNMENT_VERSION,
    hierarchy: HIERARCHY_LAYERS.map((layer) => [layer, [...policy.hierarchy[layer]]]),
    instrumentId: input.instrumentId,
    asOf,
    requestedIntervals: requested,
    inputs,
  });

  const context: ChartContext = {
    chartContextId: 'cc_' + inputFingerprint.slice(0, 40),
    engineVersion: CHART_CONTEXT_ENGINE_VERSION,
    hierarchyVersion: TIMEFRAME_HIERARCHY_VERSION,
    alignmentVersion: ALIGNMENT_VERSION,
    instrumentId: input.instrumentId,
    asOf,
    requestedIntervals: requested,
    series: first
      ? { source: first.result.series.source, session: first.result.series.session, adjustment: first.result.series.adjustment, barReplay: first.result.barReplay, useCase: first.result.useCase }
      : null,
    timeframes,
    layers,
    timeframeAlignment: { state: alignment, inputs: { position, swing, intraday } },
    currentPhase: phaseOf(alignment),
    dominantTrend: dominant,
    secularTrend: { status: 'unavailable', reason: 'weekly and monthly timeframes are not implemented in V1; no secular trend is derived from daily bars' },
    ...levels,
    coverage: { requestedIntervals: requested, readyIntervals, missingIntervals, invalidIntervals, insufficientIntervals, complete },
    provenance: {
      decisionTimeKnowledgeProven: ordered.length > 0 && ordered.every((r) => r.result.barDataProvenance.decisionTimeKnowledgeProven),
      historicalReconstruction: ordered.some((r) => r.result.barDataProvenance.historicalReconstruction),
      legacyUnproven: ordered.some((r) => r.result.barDataProvenance.legacyUnproven),
      allSignalBarsContemporaneous: ordered.length > 0 && ordered.every((r) => r.result.barDataProvenance.latestFinalBarContemporaneous),
      perTimeframe,
    },
    quality: { dataValid: invalidIntervals.length === 0, contextComplete: complete },
    inputFingerprint,
  };
  return deepFreeze(context);
}
