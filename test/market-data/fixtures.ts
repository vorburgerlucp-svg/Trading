// TEST FIXTURES ONLY. Every price below is synthetic test data (source environment "test_fixture");
// production code never ships or invents market data.

import { Decimal } from '../../src/money/decimal.js';
import type { BarInterval, BarRevisionKnowledge, BarSession, Instrument, MarketBar, MarketDataSource, PriceAdjustment } from '../../src/market-data/market-data-types.js';
import { INTERVAL_MS, isIntraday } from '../../src/market-data/market-data-types.js';
import { BAR_VINTAGE_POLICY_VERSION } from '../../src/market-data/bar-vintage.js';
import type { TradingCalendar } from '../../src/market-data/sessions.js';
import { addDays, parseUtc, toUtcIso } from '../../src/market-data/time.js';

export const FIXTURE_SOURCE: MarketDataSource = Object.freeze({
  sourceId: 'fixture:bars:test',
  provider: 'fixture',
  dataset: 'bars',
  environment: 'test_fixture',
  license: 'internal_use',
  licenseNote: 'synthetic test data',
});

export const PRODUCTION_LIKE_SOURCE: MarketDataSource = Object.freeze({
  sourceId: 'fixture:bars:production',
  provider: 'fixture',
  dataset: 'bars',
  environment: 'production',
  license: 'internal_use',
});

export const AAPL: Instrument = Object.freeze({
  instrumentId: 'ins_aapl',
  assetClass: 'stock',
  symbol: 'AAPL',
  name: 'Apple Inc',
  currency: 'USD',
  exchange: 'NASDAQ',
  mic: 'XNAS',
  timezone: 'America/New_York',
  tickSize: '0.01',
  tradingCalendar: 'XNAS',
  active: true,
});

export const BTC: Instrument = Object.freeze({
  instrumentId: 'ins_btcusd',
  assetClass: 'crypto',
  symbol: 'BTC/USD',
  currency: 'USD',
  timezone: 'UTC',
  tradingCalendar: '24x7',
  active: true,
});

export const EURUSD: Instrument = Object.freeze({
  instrumentId: 'ins_eurusd',
  assetClass: 'forex',
  symbol: 'EUR/USD',
  currency: 'USD',
  timezone: 'UTC',
  tradingCalendar: 'FX-24x5',
  active: true,
});

/** Deterministic PRNG (mulberry32) for reproducible synthetic series. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Ohlcv {
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

/** Random-walk OHLCV with 2 decimals (all consistent: low ≤ open/close ≤ high). */
export function randomOhlcv(count: number, seed = 7, start = 100): Ohlcv[] {
  const rnd = prng(seed);
  const out: Ohlcv[] = [];
  let close = start * 100;
  for (let i = 0; i < count; i++) {
    const open = close;
    close = Math.max(100, Math.round(open + (rnd() - 0.5) * 400));
    const high = Math.max(open, close) + Math.round(rnd() * 150);
    const low = Math.max(1, Math.min(open, close) - Math.round(rnd() * 150));
    const c = (n: number) => (n / 100).toFixed(2);
    out.push({ open: c(open), high: c(high), low: c(low), close: c(close), volume: String(1000 + Math.round(rnd() * 9000)) });
  }
  return out;
}

export interface BarSpec {
  instrument?: Pick<Instrument, 'instrumentId'>;
  source?: string;
  interval?: BarInterval;
  session?: BarSession;
  adjustment?: PriceAdjustment;
  /** Retrieval long after the bars (backfill); bars are final with availableAt = completion. */
  retrievedAt?: string;
  /** Revision knowledge; default: a historical reconstruction. */
  knowledge?: BarRevisionKnowledge;
}

/** Final daily bars on consecutive trading dates of a calendar, starting at `firstDate`. */
export function dailyBars(calendar: TradingCalendar, firstDate: string, rows: readonly Ohlcv[], spec: BarSpec = {}): MarketBar[] {
  const out: MarketBar[] = [];
  let date = firstDate;
  while (!calendar.session(date)) date = addDays(date, 1);
  for (const r of rows) {
    const w = calendar.dailyBarWindow(date);
    const completion = calendar.dailyBarCompletion(date)!;
    out.push(bar(r, w.start, w.end, completion, { ...spec, interval: '1d' }));
    date = addDays(date, 1);
    while (!calendar.session(date)) date = addDays(date, 1);
  }
  return out;
}

/** Final intraday bars following the calendar grid from `firstStart` (must be a valid bar start). */
export function intradayBars(calendar: TradingCalendar, firstStart: string, interval: BarInterval, rows: readonly Ohlcv[], spec: BarSpec = {}): MarketBar[] {
  if (!isIntraday(interval)) throw new Error('intraday interval expected');
  const out: MarketBar[] = [];
  let start: number | null = parseUtc(firstStart);
  for (const r of rows) {
    if (start === null) throw new Error('calendar ended');
    const w = calendar.barWindow(start, interval, spec.session === 'extended' ? 'extended' : 'regular');
    if (!w.ok) throw new Error('not a bar start: ' + toUtcIso(start) + ' (' + w.reason + ')');
    out.push(bar(r, w.start, w.end, w.end, { ...spec, interval }));
    start = calendar.nextBarStart(start, interval, spec.session === 'extended' ? 'extended' : 'regular');
  }
  return out;
}

export function bar(r: Ohlcv, start: number, end: number, completion: number, spec: BarSpec & { interval: BarInterval }): MarketBar {
  const retrievedAt = spec.retrievedAt ?? toUtcIso(Math.max(completion, end) + INTERVAL_MS['1h'] * 24 * 30);
  const b: MarketBar = {
    instrumentId: spec.instrument?.instrumentId ?? AAPL.instrumentId,
    interval: spec.interval,
    startTime: toUtcIso(start),
    endTime: toUtcIso(end),
    open: Decimal.from(r.open),
    high: Decimal.from(r.high),
    low: Decimal.from(r.low),
    close: Decimal.from(r.close),
    source: spec.source ?? FIXTURE_SOURCE.sourceId,
    session: spec.session ?? 'regular',
    adjustment: spec.adjustment ?? 'raw',
    isFinal: true,
    observedAt: toUtcIso(completion),
    availableAt: toUtcIso(completion),
    retrievedAt,
    // Fixtures are backfills by default (retrieved long after completion): reconstructions, never captures.
    knowledge: spec.knowledge ?? { knownAt: retrievedAt, knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', vintagePolicy: BAR_VINTAGE_POLICY_VERSION },
  };
  if (r.volume !== undefined) b.volume = Decimal.from(r.volume);
  return b;
}

export function flat(count: number, price = '100.10', volume = '1000'): Ohlcv[] {
  return Array.from({ length: count }, () => ({ open: price, high: price, low: price, close: price, volume }));
}

/** The bar as NEXUS retrieved it at `retrievedAt`. Every capture makes the knowledge time follow the retrieval, so both change together. */
export function retrievedAs<T extends MarketBar>(bar: T, retrievedAt: string): T {
  return { ...bar, retrievedAt, knowledge: { ...bar.knowledge, knownAt: retrievedAt } };
}
