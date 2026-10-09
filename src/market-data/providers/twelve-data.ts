// Twelve Data adapter (first real market data provider).
//
// Security: the API key lives only in a private field of this server-side object. It is sent in the
// Authorization header (never in the URL, so it cannot leak through logged URLs or error messages),
// and provider messages are scrubbed of it before they become errors. No key → no provider (fromEnv
// returns null); NEXUS never substitutes fake data for a missing source.
//
// Time: intraday series are requested with timezone=UTC; daily series are trading dates of the venue
// (Twelve Data ignores `timezone` for 1day) and are mapped to the calendar's daily window. Whether a
// bar is final is decided from the calendar and the retrieval time, never assumed.

import { Decimal } from '../../money/decimal.js';
import {
  INTERVAL_MS,
  isIntraday,
  type AssetClass,
  type BarInterval,
  type BarSession,
  type CorporateAction,
  type Instrument,
  type LicenseClass,
  type MarketBar,
  type MarketDataSource,
  type MarketQuote,
  type PriceAdjustment,
  type ProviderInstrumentMapping,
} from '../market-data-types.js';
import { MarketDataError, type HistoricalBarsRequest, type InstrumentCandidate, type MarketDataProvider, type ProviderBars, type ProviderHealthSnapshot } from '../market-data-provider.js';
import { calendarForInstrument, operatingMic, type TradingCalendar } from '../sessions.js';
import { addDays, localDateOf, parseUtc, toUtcIso, zonedToUtc } from '../time.js';
import { REAL_DEPS, ResilientCaller, parseRetryAfter, type FetchLike, type ResilienceDeps, type ResiliencePolicy } from './resilience.js';
import { errorBody, parseDividends, parseQuote, parseSplits, parseSymbolSearch, parseTimeSeries, sanitizeText, type TdTimeSeries } from './twelve-data-schema.js';

const PROVIDER = 'twelvedata';
const MAX_OUTPUT = 5000;
const TD_INTERVAL: Readonly<Record<BarInterval, string>> = { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day' };
const TD_ADJUST: Readonly<Record<PriceAdjustment, string>> = { raw: 'none', split_adjusted: 'splits', total_return_adjusted: 'all' };
const TYPE_MAP: Readonly<Record<string, AssetClass>> = {
  'Common Stock': 'stock',
  'Preferred Stock': 'stock',
  'American Depositary Receipt': 'stock',
  'Depositary Receipt': 'stock',
  'Global Depositary Receipt': 'stock',
  REIT: 'stock',
  ETF: 'etf',
  'Exchange-Traded Note': 'etf',
  'Digital Currency': 'crypto',
  'Physical Currency': 'forex',
  Index: 'index',
};
const ISO_CURRENCY = /^[A-Z]{3}$/;
const QUERY = /^[A-Za-z0-9.\-/:^ ]{1,64}$/;

export interface TwelveDataOptions {
  apiKey: string;
  environment: 'production' | 'demo';
  fetch?: FetchLike;
  baseUrl?: string;
  clock?: () => Date;
  resilience?: Partial<ResiliencePolicy>;
  deps?: ResilienceDeps;
  /** Delay after a bar's completion before it counts as final (provider settlement). */
  settleMs?: { intraday: number; daily: number };
  license?: LicenseClass;
  licenseNote?: string;
  calendarFor?: (instrument: Instrument) => TradingCalendar | null;
  maxPages?: number;
  /**
   * Only symbol/interval/outputsize are sent (the public demo key rejects everything else). Times then
   * come in exchange time and prices with the provider default adjustment (splits). Default: demo.
   */
  minimalRequests?: boolean;
}

function defaultFetch(): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status, headers: { get: (n) => res.headers.get(n) }, text: () => res.text() };
  };
}

function sessionFor(instrument: Instrument): BarSession {
  return instrument.assetClass === 'crypto' || instrument.assetClass === 'forex' ? 'continuous' : 'regular';
}

function venueParams(instrument: Instrument, mapping: ProviderInstrumentMapping): Record<string, string> {
  if (instrument.assetClass === 'crypto' || instrument.assetClass === 'forex') return mapping.exchange ? { exchange: mapping.exchange } : {};
  return instrument.mic ? { mic_code: instrument.mic } : mapping.exchange ? { exchange: mapping.exchange } : {};
}

export class TwelveDataMarketDataProvider implements MarketDataProvider {
  readonly providerId = PROVIDER;
  readonly #apiKey: string;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly clock: () => Date;
  private readonly caller: ResilientCaller;
  private readonly settle: { intraday: number; daily: number };
  private readonly calendarFor: (instrument: Instrument) => TradingCalendar | null;
  /** Non-secret settings only. The key is NEVER kept in an enumerable field (JSON/inspect/log safe). */
  private readonly settings: { environment: 'production' | 'demo'; license?: LicenseClass; licenseNote?: string; maxPages?: number; minimalRequests: boolean };

  constructor(options: TwelveDataOptions) {
    if (typeof options.apiKey !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(options.apiKey)) throw new MarketDataError('not_configured', PROVIDER, 'API key missing or malformed');
    this.#apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? defaultFetch();
    this.baseUrl = (options.baseUrl ?? 'https://api.twelvedata.com').replace(/\/+$/, '');
    this.clock = options.clock ?? (() => new Date());
    this.caller = new ResilientCaller(PROVIDER, options.resilience, options.deps ?? REAL_DEPS);
    this.settle = options.settleMs ?? { intraday: 60_000, daily: 15 * 60_000 };
    this.calendarFor = options.calendarFor ?? calendarForInstrument;
    this.settings = {
      environment: options.environment,
      minimalRequests: options.minimalRequests ?? options.environment === 'demo',
      ...(options.license !== undefined ? { license: options.license } : {}),
      ...(options.licenseNote !== undefined ? { licenseNote: options.licenseNote } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    };
  }

  /** Production provider from the server environment; null (not configured) without TWELVE_DATA_API_KEY. */
  static fromEnv(env: Record<string, string | undefined>, options: Omit<TwelveDataOptions, 'apiKey' | 'environment'> = {}): TwelveDataMarketDataProvider | null {
    const key = env.TWELVE_DATA_API_KEY?.trim();
    if (!key) return null;
    return new TwelveDataMarketDataProvider({ ...options, apiKey: key, environment: 'production' });
  }

  /** Twelve Data's documented public demo key: for smoke tests only, data is labelled "demo" and never production. */
  static publicDemo(options: Omit<TwelveDataOptions, 'apiKey' | 'environment'> = {}): TwelveDataMarketDataProvider {
    return new TwelveDataMarketDataProvider({ ...options, apiKey: 'demo', environment: 'demo', licenseNote: 'Twelve Data public demo key: test use only, never a production source' });
  }

  health(): ProviderHealthSnapshot {
    return this.caller.health();
  }

  source(dataset: 'time_series' | 'quote' | 'corporate_actions'): MarketDataSource {
    return {
      sourceId: PROVIDER + ':' + dataset + ':' + this.settings.environment,
      provider: PROVIDER,
      dataset,
      environment: this.settings.environment,
      license: this.settings.license ?? 'unreviewed',
      licenseNote: this.settings.licenseNote ?? 'Twelve Data plan terms not reviewed yet: internal use only until a human classifies them',
    };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private scrub(text: string): string {
    return sanitizeText(text.split(this.#apiKey).join('[REDACTED]'), 200);
  }

  private mapError(status: number, body: { code: number | null; message: string } | null, retryAfter: string | null): MarketDataError {
    const code = body?.code ?? status;
    const message = this.scrub(body?.message ?? 'HTTP ' + status);
    const details = { status: code, ...(parseRetryAfter(retryAfter, this.clock().getTime()) !== undefined ? { retryAfterMs: parseRetryAfter(retryAfter, this.clock().getTime())! } : {}) };
    if (code === 429) return new MarketDataError('rate_limited', PROVIDER, message, details);
    if (code === 401) return new MarketDataError('auth_failed', PROVIDER, message, details);
    if (code === 403) return new MarketDataError('not_entitled', PROVIDER, message, details);
    if (code === 404) return new MarketDataError('not_found', PROVIDER, message, details);
    if (code >= 500) return new MarketDataError('provider_unavailable', PROVIDER, message, details);
    if (code === 400 && /symbol/i.test(message) && /(not found|invalid|missing)/i.test(message)) return new MarketDataError('invalid_symbol', PROVIDER, message, details);
    return new MarketDataError('bad_request', PROVIDER, message, details);
  }

  private request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = this.baseUrl + path + '?' + new URLSearchParams(params).toString();
    return this.caller.call(async (signal) => {
      const res = await this.fetchFn(url, { method: 'GET', headers: { Authorization: 'apikey ' + this.#apiKey, Accept: 'application/json' }, signal });
      const text = await res.text();
      if (text.length > 30_000_000) throw new MarketDataError('schema_invalid', PROVIDER, 'response too large');
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const err = errorBody(body);
      if (res.status !== 200 || err) throw this.mapError(res.status, err, res.headers.get('retry-after'));
      if (body === undefined) throw new MarketDataError('schema_invalid', PROVIDER, 'response is not JSON');
      return body;
    });
  }

  // -------------------------------------------------------------------------
  // Instruments
  // -------------------------------------------------------------------------

  async searchInstruments(query: string): Promise<InstrumentCandidate[]> {
    if (typeof query !== 'string' || !QUERY.test(query)) throw new MarketDataError('bad_request', PROVIDER, 'search query must be 1-64 plain characters');
    const rows = parseSymbolSearch(await this.request('/symbol_search', { symbol: query, outputsize: '30' }));
    return rows.map((r) => ({
      provider: PROVIDER,
      providerSymbol: r.symbol,
      name: r.instrumentName,
      assetClass: TYPE_MAP[r.instrumentType] ?? null,
      providerType: r.instrumentType,
      currency: r.currency,
      exchange: r.exchange,
      mic: r.micCode,
      timezone: r.exchangeTimezone,
      country: r.country,
    }));
  }

  async getInstrument(providerSymbol: string, hint: { mic?: string; exchange?: string } = {}): Promise<InstrumentCandidate | null> {
    const candidates = await this.searchInstruments(providerSymbol);
    return candidates.find((c) => c.providerSymbol.toUpperCase() === providerSymbol.toUpperCase() && (!hint.mic || c.mic === hint.mic) && (!hint.exchange || c.exchange === hint.exchange)) ?? null;
  }

  // -------------------------------------------------------------------------
  // Bars
  // -------------------------------------------------------------------------

  private checkMeta(meta: TdTimeSeries['meta'], request: HistoricalBarsRequest): void {
    const problems: string[] = [];
    if (meta.interval !== TD_INTERVAL[request.interval]) problems.push('interval ' + meta.interval);
    if (meta.symbol.toUpperCase() !== request.mapping.providerSymbol.toUpperCase()) problems.push('symbol ' + meta.symbol);
    if (meta.exchangeTimezone && meta.exchangeTimezone !== request.instrument.timezone) problems.push('exchange time zone ' + meta.exchangeTimezone + ' ≠ ' + request.instrument.timezone);
    if (meta.micCode && request.instrument.mic && operatingMic(meta.micCode) !== operatingMic(request.instrument.mic)) problems.push('MIC ' + meta.micCode + ' ≠ ' + request.instrument.mic);
    if (problems.length > 0) throw new MarketDataError('schema_invalid', PROVIDER, 'response does not match the requested instrument/series: ' + this.scrub(problems.join(', ')));
  }

  private toBars(series: TdTimeSeries, request: HistoricalBarsRequest, retrievedMs: number, source: string, exchangeLocalTimes = false): MarketBar[] {
    const { instrument, interval } = request;
    const calendar = this.calendarFor(instrument);
    const session = sessionFor(instrument);
    const retrievedAt = toUtcIso(retrievedMs);
    return series.values.map((v) => {
      let start: number;
      let end: number;
      let completion: number;
      if (isIntraday(interval)) {
        // Full mode requests timezone=UTC; minimal mode gets exchange time, converted DST-correctly.
        start = exchangeLocalTimes
          ? zonedToUtc(v.datetime.slice(0, 10), v.datetime.slice(11, 19), series.meta.exchangeTimezone ?? instrument.timezone)
          : parseUtc(v.datetime.replace(' ', 'T') + 'Z');
        const window = calendar?.barWindow(start, interval, 'regular');
        end = window && window.ok ? window.end : start + INTERVAL_MS[interval];
        completion = end;
      } else {
        const window = calendar ? calendar.dailyBarWindow(v.datetime) : { start: zonedToUtc(v.datetime, '00:00', instrument.timezone), end: zonedToUtc(addDays(v.datetime, 1), '00:00', instrument.timezone) };
        start = window.start;
        end = window.end;
        completion = calendar?.dailyBarCompletion(v.datetime) ?? end;
      }
      const isFinal = completion + (isIntraday(interval) ? this.settle.intraday : this.settle.daily) <= retrievedMs;
      const known = isFinal ? toUtcIso(completion) : retrievedAt;
      const bar: MarketBar = {
        instrumentId: instrument.instrumentId,
        interval,
        startTime: toUtcIso(start),
        endTime: toUtcIso(end),
        open: Decimal.from(v.open),
        high: Decimal.from(v.high),
        low: Decimal.from(v.low),
        close: Decimal.from(v.close),
        source,
        session,
        adjustment: request.adjustment,
        isFinal,
        observedAt: known,
        availableAt: known,
        retrievedAt,
      };
      // FX "volume" from aggregators is not traded volume: treated as unavailable, never used.
      if (v.volume !== undefined && instrument.assetClass !== 'forex') bar.volume = Decimal.from(v.volume);
      return bar;
    });
  }

  private rangeParams(request: HistoricalBarsRequest, from: number, to: number): Record<string, string> {
    if (isIntraday(request.interval)) return { start_date: toUtcIso(from).slice(0, 19), end_date: toUtcIso(to).slice(0, 19), timezone: 'UTC' };
    const calendar = this.calendarFor(request.instrument);
    const tz = calendar ? undefined : request.instrument.timezone;
    const dateOf = (ms: number) => (calendar ? calendar.dailyBarDate(ms) : localDateOf(ms, tz!));
    return { start_date: dateOf(from), end_date: dateOf(to - 1) };
  }

  async getHistoricalBars(request: HistoricalBarsRequest): Promise<ProviderBars> {
    const from = parseUtc(request.from);
    const to = parseUtc(request.to);
    if (to <= from) throw new MarketDataError('bad_request', PROVIDER, 'empty time range');
    const source = this.source('time_series');
    if (this.settings.minimalRequests) return this.minimalBars(request, from, to);
    const maxPages = this.settings.maxPages ?? 50;
    const byStart = new Map<string, MarketBar>();
    // Remaining windows: a full page (5000 rows) may have been cut at either end, so both sides are re-requested.
    const pending: Array<[number, number]> = [[from, to]];
    let requests = 0;
    while (pending.length > 0) {
      const [f, t] = pending.shift()!;
      if (++requests > maxPages) throw new MarketDataError('bad_request', PROVIDER, 'range needs more than ' + maxPages + ' requests; split it');
      let series: TdTimeSeries;
      try {
        const body = await this.request('/time_series', {
          symbol: request.mapping.providerSymbol,
          interval: TD_INTERVAL[request.interval],
          ...this.rangeParams(request, f, t),
          order: 'asc',
          outputsize: String(MAX_OUTPUT),
          adjust: TD_ADJUST[request.adjustment],
          ...venueParams(request.instrument, request.mapping),
        });
        series = parseTimeSeries(body, isIntraday(request.interval));
      } catch (error) {
        // "No data is available on the specified dates" is an empty window, not a failure.
        if (error instanceof MarketDataError && (error.code === 'bad_request' || error.code === 'not_found') && /no data/i.test(error.message)) continue;
        throw error;
      }
      this.checkMeta(series.meta, request);
      const bars = this.toBars(series, request, this.clock().getTime(), source.sourceId);
      for (const bar of bars) {
        const s = parseUtc(bar.startTime);
        if (s >= from && s < to) byStart.set(bar.startTime, bar);
      }
      if (series.values.length >= MAX_OUTPUT && bars.length > 0) {
        const starts = bars.map((b) => parseUtc(b.startTime));
        const min = Math.min(...starts);
        const max = Math.max(...starts);
        if (min > f) pending.push([f, min]);
        if (max + 1 < t) pending.push([max + 1, t]);
      }
    }
    const bars = [...byStart.values()].sort((a, b) => parseUtc(a.startTime) - parseUtc(b.startTime));
    return { source, bars, requests };
  }

  /** Demo access: latest N bars with provider defaults, filtered to the requested window. */
  private async minimalBars(request: HistoricalBarsRequest, from: number, to: number): Promise<ProviderBars> {
    if (request.adjustment !== 'split_adjusted') {
      throw new MarketDataError('unsupported', PROVIDER, 'minimal (demo) access only returns the provider default adjustment (splits): request split_adjusted');
    }
    const step = isIntraday(request.interval) ? INTERVAL_MS[request.interval] : 86_400_000;
    const outputsize = Math.min(MAX_OUTPUT, Math.max(5, Math.ceil((Math.min(to, this.clock().getTime()) - from) / step) + 5));
    const body = await this.request('/time_series', { symbol: request.mapping.providerSymbol, interval: TD_INTERVAL[request.interval], outputsize: String(outputsize) });
    const series = parseTimeSeries(body, isIntraday(request.interval));
    this.checkMeta(series.meta, request);
    const bars = this.toBars(series, request, this.clock().getTime(), this.source('time_series').sourceId, true)
      .filter((b) => parseUtc(b.startTime) >= from && parseUtc(b.startTime) < to)
      .sort((a, b) => parseUtc(a.startTime) - parseUtc(b.startTime));
    return { source: this.source('time_series'), bars, requests: 1 };
  }

  // -------------------------------------------------------------------------
  // Quotes and corporate actions
  // -------------------------------------------------------------------------

  async getQuote(request: { instrument: Instrument; mapping: ProviderInstrumentMapping }): Promise<{ source: MarketDataSource; quote: MarketQuote }> {
    const { instrument, mapping } = request;
    const q = parseQuote(await this.request('/quote', { symbol: mapping.providerSymbol, ...(this.settings.minimalRequests ? {} : venueParams(instrument, mapping)) }));
    if (q.symbol.toUpperCase() !== mapping.providerSymbol.toUpperCase()) throw new MarketDataError('schema_invalid', PROVIDER, 'quote is for another symbol');
    const retrievedAt = toUtcIso(this.clock().getTime());
    const source = this.source('quote');
    const quote: MarketQuote = {
      instrumentId: instrument.instrumentId,
      source: source.sourceId,
      last: Decimal.from(q.close),
      open: Decimal.from(q.open),
      high: Decimal.from(q.high),
      low: Decimal.from(q.low),
      ...(q.previousClose !== undefined ? { previousClose: Decimal.from(q.previousClose) } : {}),
      ...(q.volume !== undefined && instrument.assetClass !== 'forex' ? { volume: Decimal.from(q.volume) } : {}),
      ...(q.currency && ISO_CURRENCY.test(q.currency) ? { currency: q.currency } : {}),
      marketOpen: q.isMarketOpen,
      // last_quote_at = last minute candle; `timestamp` is only the opening candle (conservative fallback).
      observedAt: toUtcIso((q.lastQuoteAt ?? q.timestamp) * 1000),
      availableAt: retrievedAt,
      retrievedAt,
    };
    return { source, quote };
  }

  async getCorporateActions(request: { instrument: Instrument; mapping: ProviderInstrumentMapping; from: string; to: string }): Promise<{ source: MarketDataSource; actions: CorporateAction[] }> {
    const { instrument, mapping } = request;
    const tz = instrument.timezone;
    const params = { symbol: mapping.providerSymbol, start_date: localDateOf(parseUtc(request.from), tz), end_date: localDateOf(parseUtc(request.to), tz), ...venueParams(instrument, mapping) };
    const retrievedMs = this.clock().getTime();
    const retrievedAt = toUtcIso(retrievedMs);
    const source = this.source('corporate_actions');
    // Provenance: the provider publishes no announcement or publication time for splits or dividends, so none is invented.
    // The only proven knowledge is NEXUS's own first capture of the record: known exactly at retrievedAt. The ex-date is an
    // economic effective time and is never used as a knowledge time (review finding F1).
    const knowledge = { provenance: 'captured_by_nexus' as const, knowledgeAt: retrievedAt };
    const actions: CorporateAction[] = [];
    const splits = parseSplits(await this.request('/splits', params));
    for (const s of splits.splits) {
      const ratioFrom = Decimal.from(s.fromFactor);
      const ratioTo = Decimal.from(s.toFactor);
      actions.push({ actionKey: 'split:' + s.date, instrumentId: instrument.instrumentId, source: source.sourceId, type: ratioTo.lt(ratioFrom) ? 'reverse_split' : 'split', exDate: s.date, ratioFrom, ratioTo, retrievedAt, knowledge });
    }
    const dividends = parseDividends(await this.request('/dividends', { ...params, adjust: 'false' }));
    for (const d of dividends.dividends) {
      const currency = dividends.currency && ISO_CURRENCY.test(dividends.currency) ? dividends.currency : instrument.currency;
      actions.push({ actionKey: 'dividend:' + d.exDate, instrumentId: instrument.instrumentId, source: source.sourceId, type: 'cash_dividend', exDate: d.exDate, cashAmount: Decimal.from(d.amount), currency, retrievedAt, knowledge });
    }
    return { source, actions };
  }
}
