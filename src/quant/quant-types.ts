// QuantResult: the auditable output of one deterministic quant run.
// Everything except createdAt is a pure function of (bars ≤ asOf, parameters, algorithm versions).
// It describes the market; it never recommends an action and contains no probabilities.

import type { Decimal } from '../money/decimal.js';
import type { FreshnessUseCase } from '../market-data/freshness.js';
import type { BarInterval, BarSession, DataQualityResult, PriceAdjustment } from '../market-data/market-data-types.js';
import type { PivotLevels } from './indicators/pivots.js';
import type { StructureLabel, StructureTrend } from './structure/market-structure.js';
import type { SupportResistanceLevel } from './structure/support-resistance.js';

export type IndicatorStatus = 'ok' | 'insufficient_data' | 'unavailable';

export interface IndicatorValue<T> {
  status: IndicatorStatus;
  value?: T;
  /** Start of the bar the value belongs to. */
  at?: string;
  requiredBars: number;
  availableBars: number;
  reason?: string;
}

export interface QuantParameters {
  sma: number[];
  ema: number[];
  rsi: number;
  macd: { fast: number; slow: number; signal: number };
  atr: number;
  adx: number;
  bollinger: { period: number; stdDev: number };
  swings: { leftBars: number; rightBars: number };
  supportResistance: { minTouches: number; toleranceAtrMultiple: string; fallbackTolerancePct: string; lookbackBars: number };
  recentSwings: number;
  structurePoints: number;
}

export interface QuantSeriesId {
  source: string;
  interval: BarInterval;
  session: BarSession;
  adjustment: PriceAdjustment;
}

export interface QuantIndicators {
  sma: Record<string, IndicatorValue<number>>;
  ema: Record<string, IndicatorValue<number>>;
  rsi: IndicatorValue<number>;
  macd: IndicatorValue<{ macd: number; signal: number; histogram: number }>;
  atr: IndicatorValue<number>;
  adx: IndicatorValue<{ adx: number; plusDI: number; minusDI: number; dx: number }>;
  bollinger: IndicatorValue<{ middle: number; upper: number; lower: number; stdDev: number; percentB: number | null; bandwidth: number | null }>;
  vwap: IndicatorValue<{ vwap: number; sessionKey: string }>;
}

export interface QuantPivots {
  status: IndicatorStatus;
  reason?: string;
  /** The previous COMPLETED period the levels are computed from. */
  basis?: { periodKey: string; high: Decimal; low: Decimal; close: Decimal; firstBar: string; lastBar: string; barCount: number; complete: boolean };
  classic?: PivotLevels;
  fibonacci?: PivotLevels;
}

export interface QuantSwing {
  kind: 'high' | 'low';
  price: Decimal;
  time: string;
  index: number;
  confirmedIndex: number;
  confirmedAt: string;
}

export interface QuantStructure {
  trend: StructureTrend;
  lastHighLabel: StructureLabel | null;
  lastLowLabel: StructureLabel | null;
  reason: string;
  points: Array<{ label: StructureLabel; kind: 'high' | 'low'; price: Decimal; time: string; confirmedAt: string }>;
}

export interface QuantSupportResistance {
  status: IndicatorStatus;
  reason?: string;
  tolerance?: Decimal;
  toleranceBasis?: 'atr' | 'percent_of_close';
  levels: SupportResistanceLevel[];
  nearestSupport?: SupportResistanceLevel;
  nearestResistance?: SupportResistanceLevel;
}

export interface WarmupEntry {
  requiredBars: number;
  availableBars: number;
  ready: boolean;
}

export interface QuantResult {
  /** Derived from inputFingerprint: identical inputs always yield the identical run id. */
  quantRunId: string;
  engineVersion: string;
  instrumentId: string;
  series: QuantSeriesId;
  asOf: string;
  mode: 'final_only' | 'include_in_progress';
  /** Freshness use case the data quality was graded for. */
  useCase: FreshnessUseCase;
  inputStart: string | null;
  inputEnd: string | null;
  barCount: number;
  inputFingerprint: string;
  dataQuality: DataQualityResult;
  algorithmVersions: Record<string, string>;
  parameters: QuantParameters;
  indicators: QuantIndicators;
  pivots: QuantPivots;
  swings: { confirmedCount: number; recent: QuantSwing[] };
  supportResistance: QuantSupportResistance;
  marketStructure: QuantStructure;
  insufficientData: boolean;
  warmupStatus: Record<string, WarmupEntry>;
  /** Not part of the deterministic content (excluded from resultHash). */
  createdAt: string;
}

export interface QuantRunRecord {
  result: QuantResult;
  /** Hash of the result without createdAt: equal inputs must give equal hashes. */
  resultHash: string;
  /** Market data ingest sequence the inputs were read at (null when bars were passed in directly). */
  storedThrough: number | null;
  createdAt: string;
}
