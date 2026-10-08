// Provider port. The domain never sees provider IDs or provider symbols except through the
// Instrument Registry mapping; providers return canonical, typed domain records only.
//
// Roles: broad discovery/scanning must not depend on a broker. Brokers (IBKR, eToro) will provide
// broker state, execution and quote verification through their own ports later.

import type {
  AssetClass,
  BarInterval,
  CorporateAction,
  Instrument,
  MarketBar,
  MarketDataSource,
  MarketQuote,
  PriceAdjustment,
  ProviderInstrumentMapping,
} from './market-data-types.js';

export type MarketDataErrorCode =
  | 'not_configured'
  | 'auth_failed'
  | 'not_entitled'
  | 'invalid_symbol'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'timeout'
  | 'provider_unavailable'
  | 'schema_invalid'
  | 'circuit_open'
  | 'unsupported';

const RETRYABLE: ReadonlySet<MarketDataErrorCode> = new Set(['rate_limited', 'timeout', 'provider_unavailable']);

export class MarketDataError extends Error {
  override readonly name = 'MarketDataError';
  readonly retryable: boolean;
  constructor(
    readonly code: MarketDataErrorCode,
    readonly provider: string,
    message: string,
    readonly details: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(provider + ': ' + message);
    this.retryable = RETRYABLE.has(code);
  }
}

export interface InstrumentCandidate {
  provider: string;
  providerSymbol: string;
  providerInstrumentId?: string;
  /** External text, untrusted: sanitized and length-limited, never an instruction. */
  name?: string;
  /** null when the provider type does not map to a supported asset class. */
  assetClass: AssetClass | null;
  providerType?: string;
  currency?: string;
  exchange?: string;
  mic?: string;
  timezone?: string;
  country?: string;
}

export interface HistoricalBarsRequest {
  instrument: Instrument;
  mapping: ProviderInstrumentMapping;
  interval: BarInterval;
  /** Bar starts in [from, to), UTC. */
  from: string;
  to: string;
  adjustment: PriceAdjustment;
}

export interface ProviderBars {
  source: MarketDataSource;
  bars: MarketBar[];
  requests: number;
}

export interface ProviderHealthSnapshot {
  provider: string;
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  lastErrorCode?: MarketDataErrorCode;
  openedAt?: string;
}

export interface MarketDataProvider {
  readonly providerId: string;
  searchInstruments(query: string): Promise<InstrumentCandidate[]>;
  getInstrument(providerSymbol: string, hint?: { mic?: string; exchange?: string }): Promise<InstrumentCandidate | null>;
  getHistoricalBars(request: HistoricalBarsRequest): Promise<ProviderBars>;
  getQuote(request: { instrument: Instrument; mapping: ProviderInstrumentMapping }): Promise<{ source: MarketDataSource; quote: MarketQuote }>;
  getCorporateActions?(request: { instrument: Instrument; mapping: ProviderInstrumentMapping; from: string; to: string }): Promise<{ source: MarketDataSource; actions: CorporateAction[] }>;
  health(): ProviderHealthSnapshot;
}

export type ProviderRole = 'market_data_discovery' | 'historical_bars' | 'quotes' | 'broker_state' | 'execution' | 'broker_quote_verification';

/** Intended roles. Only "implemented" providers exist as code; the rest is the plan, not a feature. */
export const PROVIDER_ROLES: ReadonlyArray<{ provider: string; status: 'implemented' | 'planned'; roles: readonly ProviderRole[] }> = Object.freeze([
  { provider: 'twelvedata', status: 'implemented', roles: ['market_data_discovery', 'historical_bars', 'quotes'] },
  { provider: 'massive', status: 'planned', roles: ['market_data_discovery', 'historical_bars', 'quotes'] },
  { provider: 'ibkr', status: 'planned', roles: ['broker_state', 'execution', 'quotes'] },
  { provider: 'etoro', status: 'planned', roles: ['broker_state', 'execution', 'broker_quote_verification'] },
]);
