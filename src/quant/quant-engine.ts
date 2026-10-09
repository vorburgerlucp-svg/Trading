// Quant Engine V1: market bars → deterministic, versioned QuantResult.
//
// Pure computation: no HTTP, no AI, no database. Same bars + same parameters + same algorithm
// versions + same asOf → bit-identical result (except createdAt) and the same quantRunId.
//
// No look-ahead by construction: before anything is computed, the input is cut to bars with
// availableAt <= asOf and startTime < asOf, and (by default) to final bars. Everything downstream
// — data quality, indicators, swings, levels, the fingerprint — only sees that selection, so bars
// after asOf can be changed arbitrarily without changing the result. Swings, levels, structure and
// pivots always use final bars only (an in-progress bar must not confirm a swing).

import { Decimal } from '../money/decimal.js';
import { hashOf } from '../persistence/canonical-json.js';
import { MarketDataQualityService } from '../market-data/data-quality.js';
import type { FreshnessUseCase } from '../market-data/freshness.js';
import { INTERVAL_MS, isIntraday, type DataQualityResult, type Instrument, type IntradayInterval, type MarketBar, type MarketDataSource } from '../market-data/market-data-types.js';
import type { SessionScope, TradingCalendar } from '../market-data/sessions.js';
import { canonicalUtc, parseUtc } from '../market-data/time.js';
import { assertPeriod, IndicatorError, qn, type Series } from './indicators/common.js';
import { ADX_VERSION, adx } from './indicators/adx.js';
import { ATR_VERSION, atr } from './indicators/atr.js';
import { BOLLINGER_VERSION, bollinger } from './indicators/bollinger.js';
import { EMA_VERSION, ema } from './indicators/ema.js';
import { MACD_VERSION, macd } from './indicators/macd.js';
import { PIVOT_CLASSIC_VERSION, PIVOT_FIBONACCI_VERSION, classicPivots, fibonacciPivots } from './indicators/pivots.js';
import { RSI_VERSION, rsi } from './indicators/rsi.js';
import { SMA_VERSION, sma } from './indicators/sma.js';
import { VWAP_VERSION, sessionVwap } from './indicators/vwap.js';
import { MARKET_STRUCTURE_VERSION, marketStructure } from './structure/market-structure.js';
import { SUPPORT_RESISTANCE_VERSION, supportResistance } from './structure/support-resistance.js';
import { SWING_VERSION, findSwings } from './structure/swings.js';
import type { IndicatorValue, QuantIndicators, QuantParameters, QuantPivots, QuantResult, QuantSeriesId, QuantSupportResistance, QuantSwing, WarmupEntry } from './quant-types.js';

export const QUANT_ENGINE_VERSION = 'quant-engine:v1';
export const DATA_QUALITY_VERSION = 'data-quality:v1';

export const ALGORITHM_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  sma: SMA_VERSION,
  ema: EMA_VERSION,
  rsi: RSI_VERSION,
  macd: MACD_VERSION,
  atr: ATR_VERSION,
  adx: ADX_VERSION,
  bollinger: BOLLINGER_VERSION,
  vwap: VWAP_VERSION,
  pivotsClassic: PIVOT_CLASSIC_VERSION,
  pivotsFibonacci: PIVOT_FIBONACCI_VERSION,
  swings: SWING_VERSION,
  supportResistance: SUPPORT_RESISTANCE_VERSION,
  marketStructure: MARKET_STRUCTURE_VERSION,
  dataQuality: DATA_QUALITY_VERSION,
});

export const DEFAULT_QUANT_PARAMETERS: QuantParameters = Object.freeze({
  sma: [20, 50, 200],
  ema: [12, 26, 50],
  rsi: 14,
  macd: { fast: 12, slow: 26, signal: 9 },
  atr: 14,
  adx: 14,
  bollinger: { period: 20, stdDev: 2 },
  swings: { leftBars: 3, rightBars: 3 },
  supportResistance: { minTouches: 2, toleranceAtrMultiple: '0.5', fallbackTolerancePct: '0.005', lookbackBars: 500 },
  recentSwings: 10,
  structurePoints: 12,
}) as QuantParameters;

export interface QuantInput {
  instrument: Pick<Instrument, 'instrumentId' | 'assetClass' | 'allowsNegativePrices' | 'tickSize'>;
  calendar: TradingCalendar | null;
  series: QuantSeriesId;
  bars: readonly MarketBar[];
  asOf: string;
  parameters?: Partial<QuantParameters>;
  /** Live preview including the forming bar; never the default, never for backtests. */
  includeInProgress?: boolean;
  sourceInfo?: MarketDataSource | null;
  useCase?: FreshnessUseCase;
  /** Versioned derivation the bars came from (e.g. the split-adjustment policy). Undefined for raw series: their identities are unchanged. */
  derivation?: Readonly<Record<string, string>>;
}

export function resolveParameters(overrides: Partial<QuantParameters> = {}): QuantParameters {
  const p: QuantParameters = structuredClone({ ...DEFAULT_QUANT_PARAMETERS, ...overrides });
  for (const n of [...p.sma, ...p.ema, p.rsi, p.atr, p.adx, p.bollinger.period, p.swings.leftBars, p.swings.rightBars, p.supportResistance.minTouches, p.supportResistance.lookbackBars, p.recentSwings, p.structurePoints]) assertPeriod(n);
  assertPeriod(p.macd.fast);
  assertPeriod(p.macd.slow);
  assertPeriod(p.macd.signal);
  if (p.macd.fast >= p.macd.slow) throw new IndicatorError('MACD fast must be < slow');
  if (!(p.bollinger.stdDev > 0)) throw new IndicatorError('bollinger stdDev must be positive');
  Decimal.from(p.supportResistance.toleranceAtrMultiple);
  Decimal.from(p.supportResistance.fallbackTolerancePct);
  return p;
}

function safeMs(iso: string): number {
  try {
    return parseUtc(iso);
  } catch {
    return Number.NaN;
  }
}

function fingerprintBars(bars: readonly MarketBar[]): unknown[] {
  return bars.map((b) => [b.startTime, b.endTime, b.open, b.high, b.low, b.close, b.volume ?? null, b.isFinal]);
}

function latest(series: Series, bars: readonly MarketBar[], required: number, reasonIfMissing = 'not enough history'): IndicatorValue<number> {
  const i = series.length - 1;
  const v = i >= 0 ? series[i] : null;
  if (v === null || v === undefined) return { status: 'insufficient_data', requiredBars: required, availableBars: bars.length, reason: reasonIfMissing };
  return { status: 'ok', value: qn(v), at: bars[i]!.startTime, requiredBars: required, availableBars: bars.length };
}

function unavailable<T>(required: number, available: number, reason: string): IndicatorValue<T> {
  return { status: 'unavailable', requiredBars: required, availableBars: available, reason };
}

function scopeOf(series: QuantSeriesId): SessionScope {
  return series.session === 'extended' ? 'extended' : 'regular';
}

function unavailableIndicators(p: QuantParameters, count: number, reason: string): QuantIndicators {
  return {
    sma: Object.fromEntries(p.sma.map((n) => [String(n), unavailable<number>(n, count, reason)])),
    ema: Object.fromEntries(p.ema.map((n) => [String(n), unavailable<number>(n, count, reason)])),
    rsi: unavailable(p.rsi + 1, count, reason),
    macd: unavailable(p.macd.slow + p.macd.signal - 1, count, reason),
    atr: unavailable(p.atr + 1, count, reason),
    adx: unavailable(2 * p.adx, count, reason),
    bollinger: unavailable(p.bollinger.period, count, reason),
    vwap: unavailable(1, count, reason),
  };
}

function computeIndicators(bars: readonly MarketBar[], input: QuantInput, p: QuantParameters): QuantIndicators {
  const close = bars.map((b) => b.close.toNumber());
  const high = bars.map((b) => b.high.toNumber());
  const low = bars.map((b) => b.low.toNumber());
  const hlc = { high, low, close };
  const n = bars.length;
  const at = (i: number) => bars[i]!.startTime;

  const macdS = macd(close, p.macd.fast, p.macd.slow, p.macd.signal);
  const macdReq = p.macd.slow + p.macd.signal - 1;
  const last = n - 1;
  const macdV: IndicatorValue<{ macd: number; signal: number; histogram: number }> =
    n > 0 && macdS.signal[last] !== null && macdS.signal[last] !== undefined
      ? { status: 'ok', value: { macd: qn(macdS.macd[last]!), signal: qn(macdS.signal[last]!), histogram: qn(macdS.histogram[last]!) }, at: at(last), requiredBars: macdReq, availableBars: n }
      : { status: 'insufficient_data', requiredBars: macdReq, availableBars: n, reason: 'not enough history' };

  const adxS = adx(hlc, p.adx);
  const adxV: IndicatorValue<{ adx: number; plusDI: number; minusDI: number; dx: number }> =
    n > 0 && adxS.adx[last] !== null && adxS.adx[last] !== undefined
      ? { status: 'ok', value: { adx: qn(adxS.adx[last]!), plusDI: qn(adxS.plusDI[last]!), minusDI: qn(adxS.minusDI[last]!), dx: qn(adxS.dx[last]!) }, at: at(last), requiredBars: 2 * p.adx, availableBars: n }
      : { status: 'insufficient_data', requiredBars: 2 * p.adx, availableBars: n, reason: 'not enough history' };

  const bb = bollinger(close, p.bollinger.period, p.bollinger.stdDev);
  const bbV: QuantIndicators['bollinger'] =
    n > 0 && bb.middle[last] !== null && bb.middle[last] !== undefined
      ? {
          status: 'ok',
          value: {
            middle: qn(bb.middle[last]!),
            upper: qn(bb.upper[last]!),
            lower: qn(bb.lower[last]!),
            stdDev: qn(bb.stdDev[last]!),
            percentB: bb.percentB[last] === null ? null : qn(bb.percentB[last]!),
            bandwidth: bb.bandwidth[last] === null ? null : qn(bb.bandwidth[last]!),
          },
          at: at(last),
          requiredBars: p.bollinger.period,
          availableBars: n,
        }
      : { status: 'insufficient_data', requiredBars: p.bollinger.period, availableBars: n, reason: 'not enough history' };

  let vwapV: QuantIndicators['vwap'];
  if (!isIntraday(input.series.interval)) vwapV = unavailable(1, n, 'session VWAP needs intraday bars');
  else if (!input.calendar) vwapV = unavailable(1, n, 'no trading calendar: session boundaries unknown');
  else if (n === 0) vwapV = { status: 'insufficient_data', requiredBars: 1, availableBars: 0, reason: 'no bars' };
  else {
    const calendar = input.calendar;
    const keys = bars.map((b) => {
      const w = calendar.barWindow(parseUtc(b.startTime), input.series.interval, scopeOf(input.series));
      return w.ok ? w.sessionKey : 'outside:' + b.startTime;
    });
    const vw = sessionVwap(bars.map((b, i) => ({ high: high[i]!, low: low[i]!, close: close[i]!, volume: b.volume === undefined ? null : b.volume.toNumber(), sessionKey: keys[i]! })));
    const v = vw.vwap[last];
    vwapV =
      v === null || v === undefined
        ? unavailable(1, n, vw.unavailableReason ?? 'no volume')
        : { status: 'ok', value: { vwap: qn(v), sessionKey: keys[last]! }, at: at(last), requiredBars: 1, availableBars: n };
  }

  return {
    sma: Object.fromEntries(p.sma.map((period) => [String(period), latest(sma(close, period), bars, period)])),
    ema: Object.fromEntries(p.ema.map((period) => [String(period), latest(ema(close, period), bars, period)])),
    rsi: latest(rsi(close, p.rsi), bars, p.rsi + 1),
    macd: macdV,
    atr: latest(atr(hlc, p.atr), bars, p.atr + 1),
    adx: adxV,
    bollinger: bbV,
    vwap: vwapV,
  };
}

/** Number of bars the calendar expects in one session (first bar may start before the open with epoch alignment). */
function expectedBarsInSession(calendar: TradingCalendar, key: string, session: { open: number; close: number }, interval: IntradayInterval, scope: SessionScope): number {
  const step = INTERVAL_MS[interval];
  let first = Math.floor(session.open / step) * step;
  const w = calendar.barWindow(first, interval, scope);
  if (!(w.ok && w.sessionKey === key)) first = calendar.firstBarStartAtOrAfter(session.open, interval, scope) ?? session.open;
  return 1 + calendar.expectedStartsBetween(first, session.close, interval, scope, 10_000).starts.length;
}

function computePivots(finals: readonly MarketBar[], input: QuantInput, asOfMs: number): QuantPivots {
  if (finals.length === 0) return { status: 'insufficient_data', reason: 'no completed period' };
  if (!isIntraday(input.series.interval)) {
    const b = finals[finals.length - 1]!;
    const basis = { high: b.high, low: b.low, close: b.close };
    const periodKey = input.calendar ? input.calendar.dailyBarDate(parseUtc(b.startTime)) : b.startTime.slice(0, 10);
    return { status: 'ok', basis: { periodKey, ...basis, firstBar: b.startTime, lastBar: b.startTime, barCount: 1, complete: true }, classic: classicPivots(basis), fibonacci: fibonacciPivots(basis) };
  }
  const calendar = input.calendar;
  if (!calendar) return { status: 'unavailable', reason: 'no trading calendar: periods unknown' };
  const scope = scopeOf(input.series);
  const groups = new Map<string, MarketBar[]>();
  for (const b of finals) {
    const w = calendar.barWindow(parseUtc(b.startTime), input.series.interval, scope);
    if (!w.ok) continue;
    // append in place: copying the group per bar would be O(n · bars per session)
    const group = groups.get(w.sessionKey);
    if (group) group.push(b);
    else groups.set(w.sessionKey, [b]);
  }
  const keys = [...groups.keys()].sort().reverse();
  for (const key of keys) {
    const session = calendar.session(key, scope);
    if (!session || session.close > asOfMs) continue; // current, still forming session: never a pivot basis
    const group = groups.get(key)!;
    let high = group[0]!.high;
    let low = group[0]!.low;
    for (const b of group) {
      if (b.high.gt(high)) high = b.high;
      if (b.low.lt(low)) low = b.low;
    }
    const close = group[group.length - 1]!.close;
    const expected = expectedBarsInSession(calendar, key, session, input.series.interval as IntradayInterval, scope);
    const basis = { high, low, close };
    return {
      status: 'ok',
      basis: { periodKey: key, high, low, close, firstBar: group[0]!.startTime, lastBar: group[group.length - 1]!.startTime, barCount: group.length, complete: group.length >= expected },
      classic: classicPivots(basis),
      fibonacci: fibonacciPivots(basis),
    };
  }
  return { status: 'insufficient_data', reason: 'no completed session before asOf' };
}

function priceScaleOf(bars: readonly MarketBar[], tickSize?: string): number {
  if (tickSize) return Decimal.from(tickSize).scale;
  let s = 0;
  for (const b of bars) s = Math.max(s, b.open.scale, b.high.scale, b.low.scale, b.close.scale);
  return Math.min(s, 12);
}

export function computeQuant(input: QuantInput, options: { createdAt: string }): QuantResult {
  const p = resolveParameters(input.parameters);
  const asOf = canonicalUtc(input.asOf);
  const asOfMs = parseUtc(asOf);
  const mode = input.includeInProgress ? 'include_in_progress' : 'final_only';
  const useCase: FreshnessUseCase = input.useCase ?? 'analysis';

  // 1. Point-in-time cut. Unparseable timestamps stay in so data quality rejects them (fail closed).
  const selected = input.bars.filter((b) => {
    const available = safeMs(b.availableAt);
    const start = safeMs(b.startTime);
    if (!Number.isNaN(available) && available > asOfMs) return false;
    if (!Number.isNaN(start) && start >= asOfMs) return false;
    return b.isFinal || input.includeInProgress === true;
  });

  const quality: DataQualityResult = new MarketDataQualityService().assessBars(selected, {
    instrument: input.instrument,
    calendar: input.calendar,
    interval: input.series.interval,
    session: input.series.session,
    adjustment: input.series.adjustment,
    source: input.series.source,
    asOf,
    useCase,
    ...(input.sourceInfo !== undefined ? { sourceInfo: input.sourceInfo } : {}),
    ...(input.includeInProgress ? { includeInProgress: true } : {}),
  });

  const inputFingerprint = hashOf({
    engine: QUANT_ENGINE_VERSION,
    algorithms: ALGORITHM_VERSIONS,
    derivation: input.derivation,
    parameters: p,
    instrumentId: input.instrument.instrumentId,
    series: input.series,
    asOf,
    mode,
    useCase,
    bars: fingerprintBars(selected),
  });
  const base = {
    quantRunId: 'qr_' + inputFingerprint.slice(0, 40),
    engineVersion: QUANT_ENGINE_VERSION,
    instrumentId: input.instrument.instrumentId,
    series: { ...input.series },
    asOf,
    mode,
    useCase,
    inputFingerprint,
    dataQuality: quality,
    algorithmVersions: { ...ALGORITHM_VERSIONS, ...(input.derivation ?? {}) },
    parameters: p,
    createdAt: options.createdAt,
  } as const;

  // 2. Fail closed on invalid data: nothing is computed from it.
  if (!quality.valid) {
    const reason = 'data quality ' + quality.severity + ': ' + quality.issues.filter((i) => i.severity === 'error' || i.severity === 'critical').map((i) => i.code).slice(0, 5).join(', ');
    return {
      ...base,
      inputStart: null,
      inputEnd: null,
      barCount: selected.length,
      indicators: unavailableIndicators(p, selected.length, reason),
      pivots: { status: 'unavailable', reason },
      swings: { confirmedCount: 0, recent: [] },
      supportResistance: { status: 'unavailable', reason, levels: [] },
      marketStructure: { trend: 'unknown', lastHighLabel: null, lastLowLabel: null, reason, points: [] },
      insufficientData: false,
      warmupStatus: {},
    };
  }

  // 3. Canonical order, identical duplicates collapsed (conflicting ones were rejected above).
  const bars = selected
    .map((bar) => ({ bar, start: parseUtc(bar.startTime) }))
    .sort((a, b) => a.start - b.start)
    .map((x) => x.bar)
    .filter((b, i, all) => i === 0 || b.startTime !== all[i - 1]!.startTime);
  const finals = bars.filter((b) => b.isFinal);
  const indicators = computeIndicators(bars, input, p);
  const pivots = computePivots(finals, input, asOfMs);

  // 4. Structure from final bars only.
  const swingPoints = findSwings(finals.map((b) => b.high.toNumber()), finals.map((b) => b.low.toNumber()), p.swings.leftBars, p.swings.rightBars);
  const swings: QuantSwing[] = swingPoints.map((s) => {
    const bar = finals[s.index]!;
    return { kind: s.kind, index: s.index, price: s.kind === 'high' ? bar.high : bar.low, time: bar.startTime, confirmedIndex: s.confirmedIndex, confirmedAt: finals[s.confirmedIndex]!.availableAt };
  });
  let sr: QuantSupportResistance;
  if (finals.length === 0) sr = { status: 'insufficient_data', reason: 'no final bars', levels: [] };
  else {
    const reference = finals[finals.length - 1]!.close;
    const atrValue = indicators.atr.status === 'ok' && indicators.atr.value! > 0 ? indicators.atr.value! : null;
    const tolerance = atrValue !== null ? Decimal.from(atrValue).times(p.supportResistance.toleranceAtrMultiple) : reference.abs().times(p.supportResistance.fallbackTolerancePct);
    const levels = supportResistance(swings, {
      referencePrice: reference,
      tolerance,
      minTouches: p.supportResistance.minTouches,
      lookbackBars: p.supportResistance.lookbackBars,
      lastIndex: finals.length - 1,
      priceScale: priceScaleOf(finals, input.instrument.tickSize),
    });
    const supports = levels.filter((l) => l.kind === 'support');
    const resistances = levels.filter((l) => l.kind === 'resistance');
    sr = {
      status: levels.length > 0 ? 'ok' : 'insufficient_data',
      ...(levels.length === 0 ? { reason: 'no level with ' + p.supportResistance.minTouches + ' confirmed touches' } : {}),
      tolerance,
      toleranceBasis: atrValue !== null ? 'atr' : 'percent_of_close',
      levels,
      ...(supports.length > 0 ? { nearestSupport: supports[supports.length - 1]! } : {}),
      ...(resistances.length > 0 ? { nearestResistance: resistances[0]! } : {}),
    };
  }
  const structure = marketStructure(swings);

  const warmup = (required: number, available: number): WarmupEntry => ({ requiredBars: required, availableBars: available, ready: available >= required });
  const warmupStatus: Record<string, WarmupEntry> = {
    ...Object.fromEntries(p.sma.map((n) => ['sma' + n, warmup(n, bars.length)])),
    ...Object.fromEntries(p.ema.map((n) => ['ema' + n, warmup(n, bars.length)])),
    rsi: warmup(p.rsi + 1, bars.length),
    macd: warmup(p.macd.slow + p.macd.signal - 1, bars.length),
    atr: warmup(p.atr + 1, bars.length),
    adx: warmup(2 * p.adx, bars.length),
    bollinger: warmup(p.bollinger.period, bars.length),
    swings: warmup(p.swings.leftBars + p.swings.rightBars + 1, finals.length),
  };
  const core = [...Object.values(indicators.sma), ...Object.values(indicators.ema), indicators.rsi, indicators.macd, indicators.atr, indicators.adx, indicators.bollinger];

  return {
    ...base,
    inputStart: bars[0]?.startTime ?? null,
    inputEnd: bars[bars.length - 1]?.endTime ?? null,
    barCount: bars.length,
    indicators,
    pivots,
    swings: { confirmedCount: swings.length, recent: swings.slice(-p.recentSwings) },
    supportResistance: sr,
    marketStructure: {
      trend: structure.trend,
      lastHighLabel: structure.lastHighLabel,
      lastLowLabel: structure.lastLowLabel,
      reason: structure.reason,
      points: structure.points.slice(-p.structurePoints).map((pt) => ({ label: pt.label, kind: pt.kind, price: pt.price, time: pt.time, confirmedAt: pt.confirmedAt })),
    },
    insufficientData: core.some((v) => v.status === 'insufficient_data'),
    warmupStatus,
  };
}

/** Hash of the deterministic content (everything but createdAt). */
export function quantResultHash(result: QuantResult): string {
  return hashOf({ ...result, createdAt: null });
}
