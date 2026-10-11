import { getCalendar } from '../../src/market-data/sessions.js';
import type { BarInterval, BarSession, PriceAdjustment } from '../../src/market-data/market-data-types.js';
import type { FreshnessUseCase } from '../../src/market-data/freshness.js';
import { parseUtc, toUtcIso } from '../../src/market-data/time.js';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { Decimal } from '../../src/money/decimal.js';
import { computeQuant } from '../../src/quant/quant-engine.js';
import { toRunRecord } from '../../src/quant/quant-run-store.js';
import type { QuantBarProvenance, QuantResult, QuantRunRecord } from '../../src/quant/quant-types.js';
import type { StructureLabel, StructureTrend } from '../../src/quant/structure/market-structure.js';
import type { SupportResistanceLevel } from '../../src/quant/structure/support-resistance.js';
import { AAPL, PRODUCTION_LIKE_SOURCE, dailyBars, randomOhlcv } from '../market-data/fixtures.js';

// Verified QuantRunRecords for the chart-context tests. One real Quant run is computed once; each fixture overrides only what its test
// needs and recomputes the hashes, so every record passes the same verifyRunRecord that production uses. The chart context recomputes nothing.

const XNAS = getCalendar('XNAS')!;

let base: { result: QuantResult; asOf: string } | undefined;
function template(): { result: QuantResult; asOf: string } {
  if (base) return base;
  const bars = dailyBars(XNAS, '2026-01-05', randomOhlcv(220, 77), { source: PRODUCTION_LIKE_SOURCE.sourceId }).map((b) => {
    const at = toUtcIso(parseUtc(b.observedAt) + 60_000);
    return { ...b, retrievedAt: at, knowledge: { knownAt: at, knowledgeSource: 'captured_by_nexus' as const, vintage: 'contemporaneous' as const, vintagePolicy: 'bar-vintage:v1' } };
  });
  const asOf = toUtcIso(parseUtc(bars.at(-1)!.availableAt) + 60_000);
  const result = computeQuant(
    { instrument: AAPL, calendar: XNAS, series: { source: PRODUCTION_LIKE_SOURCE.sourceId, interval: '1d', session: 'regular', adjustment: 'raw' }, bars, asOf, sourceInfo: PRODUCTION_LIKE_SOURCE, useCase: 'analysis' },
    { createdAt: '2026-12-31T00:00:00.000Z' },
  );
  base = { result, asOf };
  return base;
}

/** The as-of instant every fixture run shares unless a test changes it. */
export const ASOF = template().asOf;

const DEFAULT_LABELS: Record<StructureTrend, [StructureLabel | null, StructureLabel | null]> = {
  bullish: ['HH', 'HL'],
  bearish: ['LH', 'LL'],
  range: ['HH', 'LL'],
  unknown: [null, null],
};

export interface RunSpec {
  /** Distinguishes runs of the same interval, so their identities differ. */
  label: string;
  interval: BarInterval;
  trend?: StructureTrend;
  lastHighLabel?: StructureLabel | null;
  lastLowLabel?: StructureLabel | null;
  instrumentId?: string;
  asOf?: string;
  valid?: boolean;
  warmupReady?: boolean;
  mode?: 'final_only' | 'include_in_progress';
  engineVersion?: string;
  source?: string;
  session?: BarSession;
  adjustment?: PriceAdjustment;
  barReplay?: 'historical_research' | 'decision_time';
  useCase?: FreshnessUseCase;
  provenance?: Partial<QuantBarProvenance>;
  /** Levels as [price, touchCount]. */
  support?: Array<[string, number]>;
  resistance?: Array<[string, number]>;
  createdAt?: string;
}

function level(kind: 'support' | 'resistance', [price, touches]: [string, number]): SupportResistanceLevel {
  return {
    kind,
    priceLevel: Decimal.from(price),
    touchCount: touches,
    firstSeen: '2026-08-03T13:30:00.000Z',
    lastSeen: '2026-09-30T13:30:00.000Z',
    confirmedAt: '2026-10-01T13:30:00.000Z',
    strengthScore: 0.5,
    touches: [],
  };
}

/** One verified QuantRunRecord, built from the shared real result and overridden by the spec. */
export function quantRun(spec: RunSpec): QuantRunRecord {
  const { result: t, asOf } = template();
  const trend = spec.trend ?? 'bullish';
  const valid = spec.valid ?? true;
  const warmupReady = spec.warmupReady ?? true;
  const high = spec.lastHighLabel !== undefined ? spec.lastHighLabel : DEFAULT_LABELS[trend][0];
  const low = spec.lastLowLabel !== undefined ? spec.lastLowLabel : DEFAULT_LABELS[trend][1];
  const inputFingerprint = hashOf({ fixture: spec.label, interval: spec.interval, asOf: spec.asOf ?? asOf, instrumentId: spec.instrumentId ?? 'AAPL' });
  const result: QuantResult = {
    ...t,
    quantRunId: 'qr_' + inputFingerprint.slice(0, 40),
    engineVersion: spec.engineVersion ?? 'quant-engine:v3',
    instrumentId: spec.instrumentId ?? 'AAPL',
    series: { source: spec.source ?? PRODUCTION_LIKE_SOURCE.sourceId, interval: spec.interval, session: spec.session ?? 'regular', adjustment: spec.adjustment ?? 'raw' },
    asOf: spec.asOf ?? asOf,
    mode: spec.mode ?? 'final_only',
    useCase: spec.useCase ?? 'analysis',
    barReplay: spec.barReplay ?? 'decision_time',
    inputFingerprint,
    dataQuality: { valid, severity: valid ? 'ok' : 'error', issues: [], usableForTrading: valid, usableForBacktest: valid },
    barDataProvenance: { ...t.barDataProvenance, ...(spec.provenance ?? {}) },
    marketStructure: { trend, lastHighLabel: high, lastLowLabel: low, points: [], reason: 'fixture' },
    supportResistance: { status: 'ok', levels: [...(spec.support ?? []).map((s) => level('support', s)), ...(spec.resistance ?? []).map((r) => level('resistance', r))] },
    warmupStatus: { fixture: { requiredBars: 1, availableBars: warmupReady ? 1 : 0, ready: warmupReady } },
    insufficientData: !warmupReady,
    createdAt: spec.createdAt ?? '2026-12-31T00:00:00.000Z',
  };
  return toRunRecord(result, null);
}

/** A bullish, bearish, range or unknown run for one interval, with the default labels of its trend. */
export function trendRun(interval: BarInterval, trend: StructureTrend, extra: Partial<RunSpec> = {}): QuantRunRecord {
  return quantRun({ label: interval + ':' + trend + ':' + (extra.label ?? ''), interval, trend, ...extra });
}
