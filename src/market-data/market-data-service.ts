// MarketDataService: provider → validation → idempotent storage, and point-in-time reads with a
// data-quality verdict. The service is the only place that combines registry, providers and store;
// strategies and the quant engine never talk to a provider directly.

import { MarketDataQualityService } from './data-quality.js';
import type { FreshnessUseCase } from './freshness.js';
import type { InstrumentRegistry } from './instrument-registry.js';
import { MarketDataError, type MarketDataProvider } from './market-data-provider.js';
import type { BarQuery, IngestSummary, MarketDataStore } from './market-data-store.js';
import type { BarInterval, BarSession, DataQualityResult, Instrument, PriceAdjustment, StoredBar, StoredQuote } from './market-data-types.js';
import { calendarForInstrument } from './sessions.js';
import { toUtcIso } from './time.js';

export interface BackfillRequest {
  instrumentId: string;
  provider: string;
  interval: BarInterval;
  adjustment: PriceAdjustment;
  from: string;
  to: string;
}

export interface BackfillResult {
  source: string;
  windows: Array<{ providerSymbol: string; from: string; to: string; bars: number; summary: IngestSummary }>;
  requests: number;
}

export interface SeriesRead {
  bars: StoredBar[];
  /** Reproducibility anchor: re-reading with this storedThrough returns exactly these bars. */
  storedThrough: number;
  quality: DataQualityResult;
}

export class MarketDataService {
  private readonly providers: Map<string, MarketDataProvider>;
  private readonly quality: MarketDataQualityService;
  private readonly clock: () => Date;

  constructor(private readonly deps: { registry: InstrumentRegistry; store: MarketDataStore; providers: readonly MarketDataProvider[]; clock?: () => Date; quality?: MarketDataQualityService }) {
    this.providers = new Map(deps.providers.map((p) => [p.providerId, p]));
    this.quality = deps.quality ?? new MarketDataQualityService();
    this.clock = deps.clock ?? (() => new Date());
  }

  private instrument(instrumentId: string): Instrument {
    const instrument = this.deps.registry.get(instrumentId);
    if (!instrument) throw new MarketDataError('not_found', 'nexus', 'unknown instrument ' + instrumentId);
    return instrument;
  }

  private provider(providerId: string): MarketDataProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new MarketDataError('not_configured', providerId, 'provider is not configured (DATA NOT CONNECTED)');
    return provider;
  }

  /** Fetches and stores bars; a ticker change inside the range is handled per mapping window. */
  async backfillBars(request: BackfillRequest): Promise<BackfillResult> {
    const instrument = this.instrument(request.instrumentId);
    const provider = this.provider(request.provider);
    const windows = this.deps.registry.mappingsOverlapping(instrument.instrumentId, provider.providerId, request.from, request.to);
    if (windows.length === 0) throw new MarketDataError('not_found', provider.providerId, 'no ' + provider.providerId + ' mapping for ' + instrument.instrumentId + ' in the requested range');
    const result: BackfillResult = { source: '', windows: [], requests: 0 };
    for (const w of windows) {
      const fetched = await provider.getHistoricalBars({ instrument, mapping: w.mapping, interval: request.interval, from: w.from, to: w.to, adjustment: request.adjustment });
      await this.deps.store.registerSource(fetched.source);
      const summary = await this.deps.store.ingestBars(instrument, fetched.bars, toUtcIso(this.clock().getTime()));
      result.source = fetched.source.sourceId;
      result.requests += fetched.requests;
      result.windows.push({ providerSymbol: w.mapping.providerSymbol, from: w.from, to: w.to, bars: fetched.bars.length, summary });
    }
    return result;
  }

  async refreshQuote(instrumentId: string, providerId: string): Promise<{ quote: StoredQuote | null; summary: IngestSummary }> {
    const instrument = this.instrument(instrumentId);
    const provider = this.provider(providerId);
    const now = toUtcIso(this.clock().getTime());
    const mapping = this.deps.registry.mappingAt(instrumentId, providerId, now);
    if (!mapping) throw new MarketDataError('not_found', providerId, 'no current mapping for ' + instrumentId);
    const { source, quote } = await provider.getQuote({ instrument, mapping });
    await this.deps.store.registerSource(source);
    const summary = await this.deps.store.ingestQuotes(instrument, [quote], now);
    return { quote: await this.deps.store.latestQuote({ instrumentId, source: source.sourceId, asOf: toUtcIso(Math.max(this.clock().getTime(), Date.parse(quote.availableAt))) }), summary };
  }

  async syncCorporateActions(instrumentId: string, providerId: string, from: string, to: string): Promise<IngestSummary[]> {
    const instrument = this.instrument(instrumentId);
    const provider = this.provider(providerId);
    if (!provider.getCorporateActions) throw new MarketDataError('unsupported', providerId, 'provider has no corporate actions');
    const summaries: IngestSummary[] = [];
    for (const w of this.deps.registry.mappingsOverlapping(instrumentId, providerId, from, to)) {
      const { source, actions } = await provider.getCorporateActions({ instrument, mapping: w.mapping, from: w.from, to: w.to });
      await this.deps.store.registerSource(source);
      summaries.push(await this.deps.store.ingestCorporateActions(instrument, actions, toUtcIso(this.clock().getTime())));
    }
    return summaries;
  }

  /** Point-in-time series read with its quality verdict and reproducibility anchor. */
  async readSeries(query: Omit<BarQuery, 'storedThrough'> & { storedThrough?: number; useCase?: FreshnessUseCase }): Promise<SeriesRead> {
    const instrument = this.instrument(query.instrumentId);
    const storedThrough = query.storedThrough ?? (await this.deps.store.head(query.instrumentId));
    const bars = await this.deps.store.readBars({ ...query, storedThrough });
    const quality = this.quality.assessBars(bars, {
      instrument,
      calendar: calendarForInstrument(instrument),
      interval: query.interval,
      session: query.session as BarSession,
      adjustment: query.adjustment,
      source: query.source,
      asOf: query.asOf,
      useCase: query.useCase ?? 'analysis',
      sourceInfo: await this.deps.store.getSource(query.source),
      ...(query.from !== undefined && query.to !== undefined ? { window: { from: query.from, to: query.to } } : {}),
    });
    return { bars, storedThrough, quality };
  }
}
