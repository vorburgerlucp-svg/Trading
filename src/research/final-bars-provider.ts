// R1: the research view of a market data provider. Only historical bars, and only FINAL ones: an in-progress bar is never stored
// by the research instance (it would be revised, and a later signal must rest on final bars only). Searches, quotes and
// corporate actions are not part of R1 and are refused. The provider's own vintage and knowledge labels are passed through
// unchanged: a bar fetched after its capture window stays a historical reconstruction.

import { MarketDataError, type HistoricalBarsRequest, type MarketDataProvider, type ProviderBars, type ProviderHealthSnapshot } from '../market-data/market-data-provider.js';
import type { InstrumentCandidate } from '../market-data/market-data-provider.js';

export interface FinalBarsCounts {
  finalBars: number;
  droppedInProgress: number;
  requests: number;
  /** Final bars captured within the capture window: a live observation. */
  contemporaneous: number;
  /** Final bars fetched after the capture window: a historical reconstruction, never a live observation. */
  historicalReconstruction: number;
}

const NONE: FinalBarsCounts = Object.freeze({ finalBars: 0, droppedInProgress: 0, requests: 0, contemporaneous: 0, historicalReconstruction: 0 });

export class FinalBarsOnlyProvider implements MarketDataProvider {
  readonly providerId: string;
  /** Counts of the last getHistoricalBars call (one call per instrument and run). */
  last: FinalBarsCounts = NONE;

  constructor(private readonly inner: MarketDataProvider) {
    this.providerId = inner.providerId;
  }

  async getHistoricalBars(request: HistoricalBarsRequest): Promise<ProviderBars> {
    this.last = NONE;
    const fetched = await this.inner.getHistoricalBars(request);
    const bars = fetched.bars.filter((bar) => bar.isFinal);
    this.last = {
      finalBars: bars.length,
      droppedInProgress: fetched.bars.length - bars.length,
      requests: fetched.requests,
      contemporaneous: bars.filter((bar) => bar.knowledge.vintage === 'contemporaneous').length,
      historicalReconstruction: bars.filter((bar) => bar.knowledge.vintage === 'historical_reconstruction').length,
    };
    return { ...fetched, bars };
  }

  searchInstruments(): Promise<InstrumentCandidate[]> {
    return Promise.reject(new MarketDataError('unsupported', this.providerId, 'not part of the research instance'));
  }

  getInstrument(): Promise<InstrumentCandidate | null> {
    return Promise.reject(new MarketDataError('unsupported', this.providerId, 'not part of the research instance'));
  }

  getQuote(): Promise<never> {
    return Promise.reject(new MarketDataError('unsupported', this.providerId, 'quotes are not part of R1 (the provider has no bid/ask)'));
  }

  health(): ProviderHealthSnapshot {
    return this.inner.health();
  }
}
