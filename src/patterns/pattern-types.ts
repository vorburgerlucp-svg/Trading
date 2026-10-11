// Types of the Pattern Engine V1 (docs/PATTERN_ENGINE_V1.md). Descriptive only: no probability, no score, no trade action.

import type { BarInterval, BarSession, MarketDataSource, PriceAdjustment } from '../market-data/market-data-types.js';
import type { FreshnessUseCase } from '../market-data/freshness.js';
import type { ChartContext } from '../timeframes/chart-context.js';
import type { PatternParameters } from './pattern-parameters.js';

/** The V1 structures first, then the V1B price-action structures (docs/PATTERN_ENGINE_V1B.md). */
export const PATTERN_TYPES = Object.freeze([
  'head_and_shoulders',
  'inverse_head_and_shoulders',
  'double_top',
  'double_bottom',
  'ascending_triangle',
  'descending_triangle',
  'symmetrical_triangle',
  'resistance_breakout',
  'support_breakdown',
  'breakout_retest',
  'breakdown_retest',
  'false_breakout',
  'false_breakdown',
  'rectangle',
  'ascending_channel',
  'descending_channel',
  'rising_wedge',
  'falling_wedge',
] as const);
export type PatternType = (typeof PATTERN_TYPES)[number];

/** The V1B structures, which are not V1: their identity uses the V1B tags. */
export const PRICE_ACTION_TYPES: ReadonlySet<PatternType> = new Set<PatternType>([
  'resistance_breakout',
  'support_breakdown',
  'breakout_retest',
  'breakdown_retest',
  'false_breakout',
  'false_breakdown',
  'rectangle',
  'ascending_channel',
  'descending_channel',
  'rising_wedge',
  'falling_wedge',
]);

/** The direction of the pattern. `neutral` while a symmetrical triangle forms. */
export type PatternDirection = 'bullish' | 'bearish' | 'neutral';

export type PatternStatus =
  | 'forming'
  | 'confirmed'
  | 'retest_pending'
  | 'retest_confirmed'
  | 'target_active'
  | 'completed'
  | 'invalidated'
  | 'failed_breakout'
  | 'expired'
  | 'outcome_ambiguous';

export type PatternRunStatus = 'READY' | 'INSUFFICIENT_DATA' | 'INVALID_DATA';

export type ReplayMode = 'historical_research' | 'decision_time';

export interface PatternInstrument {
  instrumentId: string;
  assetClass: string;
  tickSize?: string;
  allowsNegativePrices: boolean;
}

export interface PatternSeries {
  source: string;
  interval: BarInterval;
  session: BarSession;
  adjustment: PriceAdjustment;
}

export interface PatternRunInput {
  instrument: PatternInstrument;
  /** The trading calendar. Null is allowed: the calendar-dependent checks then report a warning, never a pass. */
  calendar: import('../market-data/sessions.js').TradingCalendar | null;
  series: PatternSeries;
  /** The bars as supplied. Never trusted: the engine builds its own point-in-time view. */
  bars: readonly import('../market-data/market-data-types.js').MarketBar[];
  asOf: string;
  replay: ReplayMode;
  sourceInfo?: MarketDataSource | null;
  useCase?: FreshnessUseCase;
  parameters?: import('./pattern-parameters.js').PatternParameterOverrides;
  chartContext?: ChartContext;
}

export interface PatternAnchor {
  role: string;
  kind: 'high' | 'low';
  /** Exact decimal price of the bar extreme. */
  price: string;
  /** Start of the bar the extreme belongs to. */
  time: string;
  barIndex: number;
  /** When the swing was confirmed: the replay instant of its confirming bar. */
  confirmedAt: string;
}

export interface PatternObservation {
  patternInstanceId: string;
  patternObservationId: string;
  patternType: PatternType;
  direction: PatternDirection;
  status: PatternStatus;
  instrumentId: string;
  interval: BarInterval;
  series: PatternSeries;
  asOf: string;
  firstSeenAt: string;
  confirmedAt: string | null;
  invalidatedAt: string | null;
  resolvedAt: string | null;
  anchors: PatternAnchor[];
  confirmation: { direction: 'up' | 'down' | null; level: string | null; buffer: string; confirmedByBarTime: string | null };
  invalidation: { rule: string; level: string };
  target: { method: string; price: string | null };
  /** The boundary lines in the original price space, as exact text: intercept (value at bar 0) and slope (per bar). */
  boundaries: Record<string, { intercept: string; slope: string }>;
  geometryMetrics: Record<string, string>;
  chartContext: null | { chartContextId: string; dominantTrend: unknown; currentPhase: string; timeframeAlignment: string };
  evidenceRefs: { patternRunId: string; chartContextId: string | null };
}

export interface PatternRun {
  patternRunId: string;
  inputFingerprint: string;
  engineVersion: string;
  geometryVersion: string;
  lifecycleVersion: string;
  priceActionLifecycleVersion: string;
  supportResistanceVersion: string;
  swingVersion: string;
  atrVersion: string;
  instrumentId: string;
  series: PatternSeries;
  asOf: string;
  replayMode: ReplayMode;
  status: PatternRunStatus;
  inputStart: string | null;
  inputEnd: string | null;
  barCount: number;
  provenance: {
    decisionTimeKnowledgeProven: boolean;
    historicalReconstruction: boolean;
    legacyUnproven: boolean;
    latestBarContemporaneous: boolean;
  };
  chartContextRef: null | { chartContextId: string; inputFingerprint: string };
  parameters: PatternParameters;
  observations: PatternObservation[];
  issues: Array<{ code: string; message: string }>;
  diagnostics: {
    pitBarCount: number;
    swingCount: number;
    candidateCount: number;
    barsWalked: number;
    /** Level computations, one per decision bar of the breakout scan. */
    levelEvaluations: number;
    breakoutCount: number;
    /** Bars walked by the breakout, retest and false-break lifecycles. */
    priceActionBarsWalked: number;
    /** Pairs of levels tested for a rectangle birth. */
    rectangleBirthChecks: number;
    /** Consecutive swing windows tested for a channel or a wedge. */
    channelWedgeWindows: number;
  };
  createdAt: string;
}

export type PatternErrorCode = 'PATTERN_INPUT_INVALID' | 'PATTERN_CONTEXT_MISMATCH';

export class PatternError extends Error {
  override readonly name = 'PatternError';
  constructor(
    readonly code: PatternErrorCode,
    message: string,
  ) {
    super(code + ': ' + message);
  }
}
